import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { isEventOrganizer } from '@/lib/eventAuth'
import { normalizeMode, legacyEnabledFromMode } from '@/lib/paymentMode'
import { notifyEventUpdate, type SignificantChanges } from '@/lib/directMessaging'
import {
  EVENT_DATE_COLUMNS, effectiveEndDate, validateEventRange, eventRangeErrorText, normalizeEndDate, eventDays,
} from '@/lib/eventDate'
import { hasActiveTiers } from '@/lib/eventSeats'
import { eventAllows, moduleOffResponse } from '@/lib/modulesServer'
import { getRefData } from '@/lib/refDataServer'
import { chooseCity } from '@/lib/refChoice'
import { sanitizeText } from '@/lib/sanitize'
import { focusColumnsReady, selectWithFocus } from '@/lib/focusSelect'
import { parseFocus } from '@/lib/photoFocus'
import { writeAudit } from '@/lib/audit'
import { samePhone } from '@/lib/phone'
import { normalizeTypedPhone, detectCountry, getCountryFromCity } from '@/lib/phoneValidation'

export const dynamic = 'force-dynamic'

// PATCH /api/events/[id]
// Organizer (organizer_id === session.id) or admin only. Edits event details
// after publishing. Editable: title, description, date, time, end_date, end_time, venue,
// neighborhood, category, ticket_price, max_tickets, cover_photo, payment_mode,
// whatsapp_payment_enabled.
//
// On save, attendees are notified over WhatsApp — but only when a *significant*
// field changed (date / time / venue / price). Description-only edits stay
// silent. Returns { updated, notified_count }.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const { data: eventRow } = await selectWithFocus('events',
    `id, organizer_id, submitted_by, organizer_name, title, description, ${EVENT_DATE_COLUMNS}, venue, neighborhood, category, ticket_price, max_tickets, cover_photo, payment_mode, whatsapp_payment_enabled, is_active, city, price_is_from, whatsapp, managed_by_platform, booking_mode, event_status`,
    cols => supabaseAdmin.from('events').select(cols).eq('id', params.id).maybeSingle())
  type EventRow = {
    id: string; organizer_id: string | null; submitted_by: string | null; organizer_name: string | null; title: string; description: string | null
    date: string; time: string | null; end_date: string | null; end_time: string | null; venue: string | null; neighborhood: string | null
    category: string | null; ticket_price: number | null; max_tickets: number | null; cover_photo: string | null; payment_mode: string | null
    whatsapp_payment_enabled: boolean | null; is_active: boolean; city: string | null; price_is_from: boolean | null; whatsapp: string | null
    managed_by_platform: boolean | null; booking_mode: string | null; event_status: string | null; cover_focus?: string | null
  }
  const event = eventRow as unknown as EventRow | null
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (!isAdmin && !isEventOrganizer(event, session.id)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const updates: Record<string, unknown> = {}

  // Plain text/date fields — only apply keys the caller actually sent.
  if (typeof body.title === 'string' && body.title.trim())   updates.title = body.title.trim()
  if ('description' in body)  updates.description  = body.description ? String(body.description).trim() : null
  if (typeof body.date === 'string' && body.date)            updates.date = body.date
  if ('time' in body)         updates.time         = body.time || null
  if ('end_time' in body)     updates.end_time     = body.end_time || null
  if ('venue' in body)        updates.venue        = body.venue || null
  if ('neighborhood' in body) updates.neighborhood = body.neighborhood || null
  if (typeof body.category === 'string' && body.category)    updates.category = body.category
  if ('cover_photo' in body)  updates.cover_photo  = body.cover_photo || null
  // A new poster: the old one's blur placeholder and admin photo credit go,
  // and it starts centred unless a focus point comes with it.
  const posterChanged = 'cover_photo' in body && (updates.cover_photo ?? null) !== (event.cover_photo ?? null)
  if (posterChanged) {
    updates.blur_hash = typeof body.blur_hash === 'string' && body.blur_hash && updates.cover_photo ? body.blur_hash : null
    updates.photo_credit = null
  }
  // Focus point of the poster ("x y" %, null = centre) — once the column exists.
  if (('cover_focus' in body || posterChanged) && await focusColumnsReady(supabaseAdmin as never)) {
    if ('cover_focus' in body) {
      const v = body.cover_focus
      if (v === null || v === '' || v === '50 50') updates.cover_focus = null
      else if (parseFocus(v)) updates.cover_focus = String(v).trim()
      else return NextResponse.json({ error: 'Cadrage invalide / Invalid focus point', field: 'cover_focus' }, { status: 400 })
    } else updates.cover_focus = null
  }

  // What customers see about who runs it and where (the organiser edits them
  // too): city (a city we serve), « À partir de », the organiser name shown,
  // the public WhatsApp contact.
  if ('city' in body) {
    await getRefData()
    const pick = chooseCity(body.city, undefined)
    if (!pick.ok || pick.proposed) return NextResponse.json({ error: 'Ville invalide / Invalid city', field: 'city' }, { status: 400 })
    updates.city = pick.city
  }
  if ('price_is_from' in body) updates.price_is_from = body.price_is_from === true
  if ('organizer_name' in body) {
    const n = sanitizeText(body.organizer_name, 80)
    if (n.length < 2) return NextResponse.json({ error: 'Nom de l\'organisateur requis / Organiser name required', field: 'organizer_name' }, { status: 400 })
    updates.organizer_name = n
  }
  if ('whatsapp' in body) {
    const raw = typeof body.whatsapp === 'string' ? body.whatsapp.trim() : ''
    if (!raw) updates.whatsapp = null
    else {
      // A local number ("6 77 12 34 56") takes the event's country; only a
      // number typed with + / 00 says its own.
      const intl = /^(\+|00)/.test(raw)
      const r = normalizeTypedPhone(raw, (intl ? detectCountry(raw) : null) ?? getCountryFromCity(String(updates.city ?? event.city ?? '')))
      if (!r.ok) return NextResponse.json({ error: r.error, field: 'whatsapp' }, { status: 400 })
      updates.whatsapp = r.phone
    }
  }

  // Extra notification number (C3): '' clears it; otherwise typed any way and
  // normalised with the organiser's country. The same as the organiser's own
  // phone → stored as NULL (it would only duplicate).
  if ('notify_phone' in body) {
    const raw = typeof body.notify_phone === 'string' ? body.notify_phone.trim() : ''
    if (!raw) {
      updates.notify_phone = null
    } else {
      const { data: org } = event.organizer_id
        ? await supabaseAdmin.from('customers').select('phone, city').eq('id', event.organizer_id).maybeSingle()
        : { data: null }
      const r = normalizeTypedPhone(raw, (org?.phone ? detectCountry(org.phone) : null) ?? getCountryFromCity(org?.city ?? null))
      if (!r.ok) return NextResponse.json({ error: r.error, field: 'notify_phone' }, { status: 400 })
      updates.notify_phone = org?.phone && samePhone(r.phone, org.phone) ? null : r.phone
    }
  }

  // Price + capacity — normalise like the submit route (0/null = free).
  let newPrice: number | null = event.ticket_price
  if ('ticket_price' in body || 'price' in body) {
    const raw = body.ticket_price ?? body.price
    newPrice = raw != null && raw !== '' ? Math.max(0, Math.round(Number(raw))) : null
    updates.ticket_price = newPrice
    updates.price = newPrice // legacy display column kept in sync
  }
  // With tiers, capacity is the sum of their max per day (kept in sync by
  // the tier routes) — a typed value is ignored.
  if ('max_tickets' in body && !(await hasActiveTiers(event.id))) {
    updates.max_tickets = body.max_tickets != null && body.max_tickets !== ''
      ? Math.max(0, parseInt(String(body.max_tickets), 10)) : 0
  }

  // Payment mode — free events are forced to reservation_only + WhatsApp off.
  const effectivePrice = 'ticket_price' in updates ? (updates.ticket_price as number | null) : event.ticket_price
  const isPaid = !!(effectivePrice && effectivePrice > 0)
  // Paid tickets are a module (it costs money): an organiser without it can't
  // switch a paid mode on. Admins can; an unchanged mode is never refused.
  if (!isAdmin && isPaid && ('payment_mode' in body || body.whatsapp_payment_enabled === true)) {
    const wantsPaid = ('payment_mode' in body && normalizeMode(body.payment_mode) !== 'reservation_only' && normalizeMode(body.payment_mode) !== normalizeMode(event.payment_mode))
      || (body.whatsapp_payment_enabled === true && !event.whatsapp_payment_enabled)
    if (wantsPaid && !(await eventAllows(event, 'paid_tickets'))) return moduleOffResponse('organizer', 'paid_tickets')
  }
  if ('payment_mode' in body) {
    const mode = isPaid ? normalizeMode(body.payment_mode) : 'reservation_only'
    updates.payment_mode = mode
    updates.payment_enabled = legacyEnabledFromMode(mode)
  }
  if ('whatsapp_payment_enabled' in body) {
    updates.whatsapp_payment_enabled = isPaid ? !!body.whatsapp_payment_enabled : false
  }

  // Start/end range — validate the MERGED row, not just what was sent, so a new
  // start alone can't jump past a stored end date. Only checked when a range
  // field was sent: an unrelated edit is never refused over the stored range.
  const rangeSent = 'date' in updates || 'time' in updates || 'end_date' in body || 'end_time' in updates
  const merged = {
    date:     'date' in updates ? String(updates.date) : event.date,
    time:     'time' in updates ? (updates.time as string | null) : event.time,
    end_date: 'end_date' in body ? (body.end_date || null) : event.end_date,
    end_time: 'end_time' in updates ? (updates.end_time as string | null) : event.end_time,
  }
  if (rangeSent) {
    const rangeError = validateEventRange(merged)
    if (rangeError) {
      return NextResponse.json({ error: eventRangeErrorText(rangeError) }, { status: 400 })
    }
  }
  // Re-derive the stored end whenever either day moved: equal to the new start → NULL.
  if ('date' in updates || 'end_date' in body) {
    updates.end_date = normalizeEndDate(merged.date, merged.end_date)
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Aucun champ à mettre à jour / Nothing to update' }, { status: 400 })
  }

  // Bookings are per day (event_reservations.event_date). A single-day event
  // that moves takes its bookings with it (below, after the update). Any other
  // range change is refused while active bookings sit on a day it would drop.
  const datesMoved = 'date' in updates || 'end_date' in body
  const oldDays = eventDays(event)
  const newDays = datesMoved
    ? eventDays({ date: merged.date, end_date: (updates.end_date as string | null) ?? null })
    : oldDays
  const singleDayMove = datesMoved && oldDays.length === 1 && newDays.length === 1 && oldDays[0] !== newDays[0]
  if (datesMoved && !singleDayMove) {
    const { data: held, error: heldErr } = await supabaseAdmin
      .from('event_reservations')
      .select('event_date')
      .eq('event_id', event.id)
      .in('reservation_status', ['pending', 'confirmed', 'attended'])
      .not('event_date', 'is', null)
    if (heldErr) {
      console.error('[events/PATCH] booked-days check failed:', heldErr.message)
      return NextResponse.json({ error: 'Erreur — réessayez. / Error — please try again.' }, { status: 500 })
    }
    const stranded = Array.from(new Set((held ?? []).map(r => String(r.event_date))))
      .filter(d => !newDays.includes(d)).sort()
    if (stranded.length > 0) {
      return NextResponse.json({
        error: `Des réservations existent le ${stranded.join(', ')} — gardez ces jours ou annulez-les d'abord. / Bookings exist on ${stranded.join(', ')} — keep those days or cancel them first.`,
        stranded_days: stranded,
      }, { status: 409 })
    }
  }

  const { data: updated, error: updErr } = await supabaseAdmin
    .from('events').update(updates).eq('id', event.id)
    .select(`id, title, ${EVENT_DATE_COLUMNS}, venue`)
    .single()
  if (updErr || !updated) {
    console.error('[events/PATCH] update failed:', updErr?.message)
    return NextResponse.json({ error: updErr?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  if (singleDayMove) {
    const { error: moveErr } = await supabaseAdmin
      .from('event_reservations')
      .update({ event_date: newDays[0], updated_at: new Date().toISOString() })
      .eq('event_id', event.id)
      .eq('event_date', oldDays[0])
    if (moveErr) console.error('[events/PATCH] moving bookings %s → %s failed:', oldDays[0], newDays[0], moveErr.message)
    else console.log('[events/PATCH] event=%s bookings moved %s → %s', event.id, oldDays[0], newDays[0])
  }

  // Significant-change detection — compare against the pre-update snapshot.
  // Dates compare the whole range: a new start OR a new last day both count.
  const changes: SignificantChanges = {}
  if (updated.date !== event.date || effectiveEndDate(updated) !== effectiveEndDate(event)) changes.date = true
  if (('time' in updates && (updates.time ?? null) !== (event.time ?? null)) ||
      ('end_time' in updates && (updates.end_time ?? null) !== (event.end_time ?? null))) changes.time = true
  if (('venue' in updates && (updates.venue ?? null) !== (event.venue ?? null)) ||
      ('city' in updates && updates.city !== event.city)) changes.venue = true
  if ('ticket_price' in updates && (updates.ticket_price ?? null) !== (event.ticket_price ?? null)) {
    changes.price = { to: (updates.ticket_price as number | null) }
  }

  // notifyEventUpdate writes the event_updated audit row and, when a
  // significant field changed, pings attendees. Pending events have no
  // audience (you can't reserve a draft), so this safely returns 0 for them.
  // The poster and its focus point: one audit row per field changed.
  for (const field of ['cover_photo', 'cover_focus'] as const) {
    if (!(field in updates)) continue
    const old = (event[field] ?? null) as string | null
    if ((updates[field] ?? null) === old) continue
    await writeAudit({
      action: 'event_photo_changed', targetType: 'event', targetId: event.id,
      performedBy: session.id, performedByType: isAdmin ? session.role : 'organiser',
      previousData: { [field]: old }, metadata: { field, old, new: updates[field] ?? null, title: event.title },
    })
  }

  const notified = await notifyEventUpdate(
    {
      id: updated.id, title: updated.title, date: updated.date, time: updated.time,
      end_date: updated.end_date, end_time: updated.end_time, venue: updated.venue,
    },
    changes,
    session.id,
    session.role,
  )

  return NextResponse.json({ updated: true, notified_count: notified })
}
