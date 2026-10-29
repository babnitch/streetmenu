import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rateLimit'
import { ensureScanToken } from '@/lib/scanTokens'
import { isEventOrganizer } from '@/lib/eventAuth'
import { HANDOVER_FROM } from '@/lib/orderDelivery'

export const dynamic = 'force-dynamic'

// POST /api/scan/code (Q2) — the "type the code" fallback.
// { restaurant_id, code }  an order's 4-character code (open orders of that
//                          restaurant), or a voucher code (its latest unused
//                          claim)
// { event_id, code }       a booking's reservation code
// → { token } for the same check screen as a scanned QR (validated with
// via: 'code'). Only the restaurant's team / the event's organiser or door
// staff / an admin may look codes up.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  const hit = rateLimit({ key: `scan:code:${session.id}`, max: 30, windowMs: 60_000 })
  if (hit) return NextResponse.json({ error: hit.message }, { status: 429 })
  const body = await req.json().catch(() => ({})) as { restaurant_id?: unknown; event_id?: unknown; code?: unknown }
  const code = String(body.code ?? '').trim().replace(/^#/, '').toUpperCase()
  if (code.length < 3 || code.length > 32) return NextResponse.json({ error: 'Code invalide / Invalid code' }, { status: 400 })
  const admin = ['super_admin', 'admin', 'moderator'].includes(session.role)
  const notFound = NextResponse.json({ error: 'Code introuvable / Code not found' }, { status: 404 })

  if (typeof body.restaurant_id === 'string') {
    const rid = body.restaurant_id
    if (!admin) {
      const { count } = await supabaseAdmin.from('restaurant_team').select('id', { count: 'exact', head: true })
        .eq('restaurant_id', rid).eq('customer_id', session.id).eq('status', 'active')
      if (!count) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }
    if (/^[0-9A-F]{4}$/.test(code)) {
      const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
      const { data: orders } = await supabaseAdmin.from('orders').select('id, status')
        .eq('restaurant_id', rid).gte('created_at', since).order('created_at', { ascending: false }).limit(300)
      const matches = ((orders ?? []) as Array<{ id: string; status: string }>).filter(o => o.id.replace(/-/g, '').slice(-4).toUpperCase() === code)
      const open = matches.find(o => (HANDOVER_FROM as readonly string[]).includes(o.status)) ?? matches[0]
      if (open) return NextResponse.json({ kind: 'order', token: await ensureScanToken('order', open.id) })
    }
    const { data: v } = await supabaseAdmin.from('vouchers').select('id, restaurant_id').eq('code', code).maybeSingle()
    if (v && (!v.restaurant_id || v.restaurant_id === rid)) {
      const { data: cv } = await supabaseAdmin.from('customer_vouchers').select('id')
        .eq('voucher_id', v.id).is('used_at', null).order('claimed_at', { ascending: false }).limit(1).maybeSingle()
      if (cv) return NextResponse.json({ kind: 'voucher', token: await ensureScanToken('voucher', cv.id as string) })
    }
    return notFound
  }

  if (typeof body.event_id === 'string') {
    const eid = body.event_id
    const { data: ev } = await supabaseAdmin.from('events').select('id, organizer_id, submitted_by').eq('id', eid).maybeSingle()
    if (!ev) return notFound
    if (!admin && !isEventOrganizer(ev, session.id)) {
      const { count } = await supabaseAdmin.from('event_door_staff').select('id', { count: 'exact', head: true })
        .eq('event_id', eid).eq('customer_id', session.id).eq('status', 'active')
      if (!count) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }
    const { data: r } = await supabaseAdmin.from('event_reservations').select('id, booking_id')
      .eq('event_id', eid).eq('reservation_code', code).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!r) return notFound
    const bookingId = (r.booking_id as string | null) ?? (r.id as string)
    return NextResponse.json({ kind: 'reservation', token: await ensureScanToken('reservation', bookingId) })
  }
  return NextResponse.json({ error: 'restaurant_id ou event_id requis / restaurant_id or event_id required' }, { status: 400 })
}
