// Admin → Messages → "who paid and heard nothing".
//
// Lists, for the last WINDOW_DAYS:
//   - paid orders and paid event reservations whose CUSTOMER never got a
//     payment confirmation Twilio accepted (no payment_confirmation row to
//     their number in sent / delivered / read), with the last attempt's
//     status and error and its retry-queue state;
//   - the retry queue itself (lib/messageRetry.ts) — pending, in flight and
//     given up.
//
// Same access rule as /api/admin/messages: super_admin / admin only, the
// bodies and numbers here are customer PII.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { normalizeLogNumber } from '@/lib/messageLog'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const WINDOW_DAYS = 7
const DELIVERED_OK = new Set(['sent', 'delivered', 'read'])

interface PaidRow {
  kind:          'order' | 'reservation'
  id:            string
  ref:           string
  customer_name: string | null
  customer_phone: string | null
  total_price:   number | null
  created_at:    string
}

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const [ordersRes, resvRes, queueRes] = await Promise.all([
    supabaseAdmin.from('orders')
      .select('id, customer_name, customer_phone, total_price, created_at')
      .eq('payment_status', 'paid').gte('created_at', since)
      .order('created_at', { ascending: false }).range(0, 499),
    supabaseAdmin.from('event_reservations')
      .select('id, reservation_code, customer_name, customer_phone, total_price, created_at')
      .eq('payment_status', 'paid').gte('created_at', since)
      .order('created_at', { ascending: false }).range(0, 499),
    supabaseAdmin.from('message_retry_queue')
      .select('id, to_number, context, related_id, status, attempts, next_attempt_at, last_error_code, last_error, created_at')
      .in('status', ['pending', 'sending', 'gave_up'])
      .gte('created_at', since)
      .order('created_at', { ascending: false }).range(0, 199),
  ])
  if (ordersRes.error || resvRes.error) {
    const msg = ordersRes.error?.message ?? resvRes.error?.message
    console.error('[admin/messages/failed] paid rows query failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
  // The queue table arrives with supabase-message-retry.sql; before that the
  // paid-but-unconfirmed list still works.
  if (queueRes.error) console.error('[admin/messages/failed] queue query failed:', queueRes.error.message)
  const queue = queueRes.error ? null : (queueRes.data ?? [])

  const paid: PaidRow[] = [
    ...(ordersRes.data ?? []).map(o => ({
      kind: 'order' as const, id: o.id as string,
      ref: (o.id as string).replace(/-/g, '').slice(-4).toUpperCase(),
      customer_name: o.customer_name as string | null, customer_phone: o.customer_phone as string | null,
      total_price: o.total_price as number | null, created_at: o.created_at as string,
    })),
    ...(resvRes.data ?? []).map(r => ({
      kind: 'reservation' as const, id: r.id as string,
      ref: (r.reservation_code as string | null) ?? (r.id as string).replace(/-/g, '').slice(-4).toUpperCase(),
      customer_name: r.customer_name as string | null, customer_phone: r.customer_phone as string | null,
      total_price: r.total_price as number | null, created_at: r.created_at as string,
    })),
  ].filter(p => !!p.customer_phone)

  // Every payment-confirmation attempt for those rows, newest first.
  const ids = paid.map(p => p.id)
  const logs: Array<{ related_id: string; to_number: string; status: string; error_code: string | null; created_at: string }> = []
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabaseAdmin.from('message_log')
      .select('related_id, to_number, status, error_code, created_at')
      .eq('context', 'payment_confirmation')
      .in('related_id', ids.slice(i, i + 200))
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[admin/messages/failed] message_log query failed:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    logs.push(...((data ?? []) as typeof logs))
  }

  const unconfirmed = paid.flatMap(p => {
    const phone = normalizeLogNumber(p.customer_phone)
    const mine = logs.filter(l => l.related_id === p.id && l.to_number === phone)
    if (mine.some(l => DELIVERED_OK.has(l.status))) return []
    const last = mine[0] ?? null
    const retry = queue?.find(q => q.related_id === p.id && q.to_number === phone) ?? null
    return [{
      ...p,
      last_status:     last?.status ?? null,       // null = no attempt logged at all
      last_error_code: last?.error_code ?? null,
      last_attempt_at: last?.created_at ?? null,
      retry_status:    retry?.status ?? null,
      retry_next_at:   retry?.next_attempt_at ?? null,
    }]
  }).sort((a, b) => b.created_at.localeCompare(a.created_at))

  return NextResponse.json({ windowDays: WINDOW_DAYS, unconfirmed, queue, queueAvailable: queue !== null })
}
