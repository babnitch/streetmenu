// Admin message log — list + stats.
//
// Backs the "📨 Messages" admin tab and the per-customer message history in
// admin → Accounts. Reads message_log through the service-role client (the
// table is RLS-locked to service_role), so the session role check below is
// the only thing standing between an admin and everyone's message bodies —
// which include verification codes. Keep it strict.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { normalizeLogNumber } from '@/lib/messageLog'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const PAGE_SIZE = 100

// Stats window. Rates over "all time" get less useful the longer the log
// runs; 30 days matches how the team actually reads deliverability.
const STATS_DAYS = 30

const COLUMNS =
  'id, twilio_sid, direction, channel, from_number, to_number, body, status, ' +
  'status_updated_at, error_code, error_message, context, related_id, customer_id, cost, created_at'

// The dashboard's context filter groups the fine-grained context values into
// the four buckets an admin actually thinks in.
const CONTEXT_GROUPS: Record<string, string[]> = {
  verification: ['verification_code'],
  orders:       ['order_notification', 'order_status_update', 'payment_confirmation'],
  events:       ['event_reservation', 'event_update'],
  broadcasts:   ['broadcast', 'subscription_alert', 'direct_message'],
}

function startOfToday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const sp         = req.nextUrl.searchParams
  const status     = sp.get('status')     ?? 'all'
  const channel    = sp.get('channel')    ?? 'all'
  const context    = sp.get('context')    ?? 'all'
  const phone      = (sp.get('phone')     ?? '').trim()
  const from       = sp.get('from')       ?? ''      // YYYY-MM-DD
  const to         = sp.get('to')         ?? ''      // YYYY-MM-DD, inclusive
  const customerId = sp.get('customerId') ?? ''
  const page       = Math.max(0, Number(sp.get('page') ?? 0) || 0)
  const withStats  = sp.get('stats') !== '0'

  let q = supabaseAdmin
    .from('message_log')
    .select(COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false })

  if (status  !== 'all') q = q.eq('status', status)
  if (channel !== 'all') q = q.eq('channel', channel)
  if (context !== 'all') {
    const group = CONTEXT_GROUPS[context]
    q = group ? q.in('context', group) : q.eq('context', context)
  }
  if (phone) {
    // Match on the digits only, so "670 00 00 00", "+237670000000" and
    // "237670000000" all find the same rows.
    const digits = phone.replace(/\D/g, '')
    if (digits) q = q.ilike('to_number', `%${digits}%`)
  }
  if (from) q = q.gte('created_at', new Date(`${from}T00:00:00`).toISOString())
  if (to)   q = q.lte('created_at', new Date(`${to}T23:59:59.999`).toISOString())

  if (customerId) {
    // Rows written before we knew the customer id (guest checkout, bot
    // replies) only carry the phone, so match on either. Look the phone up
    // first — without it we'd silently under-report a customer's history.
    const { data: cust } = await supabaseAdmin
      .from('customers')
      .select('phone')
      .eq('id', customerId)
      .maybeSingle()
    const custPhone = normalizeLogNumber(cust?.phone)
    q = custPhone
      ? q.or(`customer_id.eq.${customerId},to_number.eq.${custPhone}`)
      : q.eq('customer_id', customerId)
  }

  const { data, count, error } = await q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
  if (error) {
    console.error('[admin/messages] list failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const payload: Record<string, unknown> = {
    messages:  data ?? [],
    total:     count ?? 0,
    page,
    pageSize:  PAGE_SIZE,
    hasMore:   (count ?? 0) > (page + 1) * PAGE_SIZE,
  }

  if (withStats) payload.stats = await buildStats()

  return NextResponse.json(payload)
}

interface Stats {
  today:        number
  week:         number
  month:        number
  windowDays:   number
  windowTotal:  number
  delivered:    number
  read:         number
  failed:       number
  undelivered:  number
  queued:       number
  sent:         number
  whatsappSent: number
  deliveryRate: number | null   // % of window messages delivered/read
  readRate:     number | null   // % of WhatsApp messages read — null when none
  totalCost:    number
}

// Three head-only counts for the headline totals, then one bulk read of the
// stats window for the rate/cost breakdown. Cheaper than six count queries
// and gives us the cost sum, which PostgREST can't aggregate for us here.
async function buildStats(): Promise<Stats | null> {
  try {
    const [todayRes, weekRes, monthRes, windowRes] = await Promise.all([
      supabaseAdmin.from('message_log').select('id', { count: 'exact', head: true })
        .gte('created_at', startOfToday()),
      supabaseAdmin.from('message_log').select('id', { count: 'exact', head: true })
        .gte('created_at', daysAgo(7)),
      supabaseAdmin.from('message_log').select('id', { count: 'exact', head: true })
        .gte('created_at', daysAgo(30)),
      supabaseAdmin.from('message_log').select('status, channel, cost')
        .gte('created_at', daysAgo(STATS_DAYS))
        .range(0, 19999),
    ])

    const rows = (windowRes.data ?? []) as Array<{ status: string; channel: string; cost: number | null }>
    const tally = { delivered: 0, read: 0, failed: 0, undelivered: 0, queued: 0, sent: 0 }
    let whatsappSent = 0
    let totalCost = 0
    for (const r of rows) {
      if (r.status in tally) tally[r.status as keyof typeof tally]++
      if (r.channel === 'whatsapp') whatsappSent++
      if (r.cost) totalCost += Number(r.cost)
    }

    const windowTotal = rows.length
    // 'read' implies delivered — WhatsApp stops sending 'delivered' once the
    // recipient opens the chat, so counting read as delivered avoids a
    // delivery rate that drops when engagement goes UP.
    const deliveredish = tally.delivered + tally.read

    return {
      today:        todayRes.count ?? 0,
      week:         weekRes.count  ?? 0,
      month:        monthRes.count ?? 0,
      windowDays:   STATS_DAYS,
      windowTotal,
      ...tally,
      whatsappSent,
      deliveryRate: windowTotal  ? Math.round((deliveredish / windowTotal) * 1000) / 10 : null,
      readRate:     whatsappSent ? Math.round((tally.read / whatsappSent) * 1000) / 10 : null,
      totalCost:    Math.round(totalCost * 100000) / 100000,
    }
  } catch (e) {
    console.error('[admin/messages] stats failed:', (e as Error).message)
    return null
  }
}
