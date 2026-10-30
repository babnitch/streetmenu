import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sanitizeText } from '@/lib/sanitize'
import { normalizePhone } from '@/lib/phone'
import { EVENT_CATEGORIES } from '@/lib/categoryLabels'
import { validateEventRange, eventRangeErrorText, normalizeEndDate } from '@/lib/eventDate'
import { EVENT_POSTER_REQUIRED_TEXT, hasPictureUrl } from '@/lib/pictureRequired'

export const dynamic = 'force-dynamic'

// GET /api/admin/events
// Admin/super_admin/moderator only. Returns EVERY event regardless of
// is_active — the admin console must see pending (is_active=false) events
// awaiting approval, which the public RLS policy (public_active_read:
// is_active = TRUE) hides from the browser's anon client.
//
// Aggregates (reservations/revenue/commission) and submitter trust are
// computed here too because event_reservations + customers are locked to
// service-role by supabase-rls-policies.sql — the client can't read them.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  // No filters (no is_active / date / city / limit) — the admin console must
  // see every event. Supabase caps unbounded selects at 1000 rows by default;
  // an explicit .range keeps that ceiling obvious and lifts it if the table
  // ever grows past it.
  const { data: events, error } = await supabaseAdmin
    .from('events')
    .select('*')
    .order('created_at', { ascending: false })
    .range(0, 9999)
  if (error) {
    console.error('[admin/events] query failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const list = events ?? []
  const inactive = list.filter(e => !e.is_active).length
  console.log('[admin/events] returning %d events (%d pending / %d active)',
    list.length, inactive, list.length - inactive)
  if (list.length === 0) {
    return NextResponse.json({ events: [], aggregates: {}, submitters: {} })
  }

  // Reservation aggregates — single query, grouped by event. Cancelled
  // reservations are excluded from the count; only 'paid' rows contribute
  // to revenue + platform commission.
  const ids = list.map(e => e.id)
  const { data: resv } = await supabaseAdmin
    .from('event_reservations')
    .select('event_id, payment_status, reservation_status, total_price, quantity, commission_amount')
    .in('event_id', ids)

  type Agg = { reservations_count: number; tickets_count: number; revenue: number; commission: number }
  const aggregates: Record<string, Agg> = {}
  for (const r of resv ?? []) {
    const a = aggregates[r.event_id] ?? { reservations_count: 0, tickets_count: 0, revenue: 0, commission: 0 }
    if (r.reservation_status !== 'cancelled') {
      a.reservations_count += 1
      a.tickets_count      += Number(r.quantity ?? 0)
    }
    if (r.payment_status === 'paid') {
      a.revenue    += Number(r.total_price ?? 0)
      a.commission += Number(r.commission_amount ?? 0)
    }
    aggregates[r.event_id] = a
  }

  // Submitter trust info — unique organizer_id set, single query.
  const submitters: Record<string, unknown> = {}
  const orgIds = Array.from(new Set(list.map(e => e.organizer_id).filter(Boolean) as string[]))
  if (orgIds.length > 0) {
    const { data: subs } = await supabaseAdmin
      .from('customers')
      .select('id, name, phone, events_approved_count, event_auto_approve, organizer_modules')
      .in('id', orgIds)
    for (const s of subs ?? []) submitters[s.id] = s
  }

  return NextResponse.json({ events: list, aggregates, submitters })
}

// POST /api/admin/events (N3) — an event listed by the admin, with no
// organiser: "managed by Tchop & Ndjoka" (managed_by_platform). Nobody is
// messaged — not the contact, not the subscribers. It takes free
// reservations only (lib/modulesServer.ts MANAGED_EVENT_MODULES) until an
// organiser is linked (POST …/[id]/organizer). A price is shown as the
// entry price; there are no paid tickets or ticket tiers.
//
// Body: title, category, city, date, time?, end_date?, end_time?, venue?,
// neighborhood?, description?, cover_photo (required), price?, max_tickets?,
// whatsapp? (public contact), notify_phone? (gets the bookings),
// organizer_name? (display), publish (default true; false = pending).
// I6: booking_mode 'info' (DEFAULT — no booking, payment or QR here, a
// "Billets / Infos" link instead) or 'platform' (free reservations);
// info_link? (https), price_is_from? ("À partir de").
// super_admin | admin.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const title = sanitizeText(body.title, 140)
  const city = sanitizeText(body.city, 60)
  const category = String(body.category ?? '')
  const date = String(body.date ?? '')
  if (!title || !city || !date || !(EVENT_CATEGORIES as readonly string[]).includes(category)) {
    return NextResponse.json({ error: 'Champs requis manquants / Missing required fields' }, { status: 400 })
  }
  // I1: a managed event may have no poster — the generated cover shows
  // until a real one is uploaded. A given poster must be a real picture URL.
  const cover = typeof body.cover_photo === 'string' && body.cover_photo.trim() ? body.cover_photo.trim() : null
  if (cover && !hasPictureUrl(cover)) {
    return NextResponse.json({ error: EVENT_POSTER_REQUIRED_TEXT, field: 'cover_photo' }, { status: 400 })
  }
  const range = {
    date,
    time:     body.time ? String(body.time) : null,
    end_date: body.end_date ? String(body.end_date) : null,
    end_time: body.end_time ? String(body.end_time) : null,
  }
  const rangeError = validateEventRange(range)
  if (rangeError) return NextResponse.json({ error: eventRangeErrorText(rangeError) }, { status: 400 })

  const phoneOrNull = (raw: unknown, field: string): string | null | NextResponse => {
    const t = typeof raw === 'string' ? raw.trim() : ''
    if (!t) return null
    const p = normalizePhone(t)
    return /^\+\d{8,15}$/.test(p) ? p : NextResponse.json({ error: 'Numéro invalide / Invalid number', field }, { status: 400 })
  }
  const whatsapp = phoneOrNull(body.whatsapp, 'whatsapp')
  if (whatsapp instanceof NextResponse) return whatsapp
  const notifyPhone = phoneOrNull(body.notify_phone, 'notify_phone')
  if (notifyPhone instanceof NextResponse) return notifyPhone

  const rawPrice = body.price
  const price = rawPrice != null && rawPrice !== '' ? Math.max(0, Math.round(Number(rawPrice)) || 0) : null
  const maxTickets = body.max_tickets != null && body.max_tickets !== '' ? Math.max(0, parseInt(String(body.max_tickets), 10) || 0) : 0
  const publish = body.publish !== false
  const bookingMode = body.booking_mode === 'platform' ? 'platform' : 'info'
  const infoLink = typeof body.info_link === 'string' ? body.info_link.trim() : ''
  if (infoLink && (!/^https?:\/\/\S+$/.test(infoLink) || infoLink.length > 500)) {
    return NextResponse.json({ error: 'Lien invalide (https://…) / Invalid link (https://…)', field: 'info_link' }, { status: 400 })
  }

  const { data: event, error } = await supabaseAdmin.from('events').insert({
    title,
    description:  sanitizeText(body.description, 2000) || null,
    date:         range.date,
    time:         range.time,
    end_date:     normalizeEndDate(range.date, range.end_date),
    end_time:     range.end_time,
    venue:        sanitizeText(body.venue, 120) || null,
    city,
    neighborhood: sanitizeText(body.neighborhood, 80) || null,
    category,
    price,
    ticket_price: price,
    max_tickets:  bookingMode === 'info' ? 0 : maxTickets,
    booking_mode: bookingMode,
    info_link:    infoLink || null,
    price_is_from: body.price_is_from === true,
    payment_enabled: false,
    payment_mode: 'reservation_only',
    whatsapp_payment_enabled: false,
    requires_confirmation: false,
    cover_photo:  cover,
    whatsapp,
    notify_phone: notifyPhone,
    organizer_name: sanitizeText(body.organizer_name, 80) || 'Tchop & Ndjoka',
    organizer_id: null,
    managed_by_platform: true,
    is_active:    publish,
    auto_approved: false,
    event_status: 'upcoming',
  }).select('*').single()
  if (error || !event) {
    console.error('[admin/events] insert failed:', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Erreur serveur / Server error' }, { status: 500 })
  }
  await writeAudit({
    action: 'event_created_by_admin', targetType: 'event', targetId: event.id,
    performedBy: session.id, performedByType: session.role,
    metadata: { title, city, published: publish, managed: true, booking_mode: bookingMode },
  })
  return NextResponse.json({ ok: true, event })
}
