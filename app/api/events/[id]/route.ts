import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { isEventOrganizer } from '@/lib/eventAuth'
import { normalizeMode, legacyEnabledFromMode } from '@/lib/paymentMode'
import { notifyEventUpdate, type SignificantChanges } from '@/lib/directMessaging'
import {
  EVENT_DATE_COLUMNS, effectiveEndDate, validateEventRange, eventRangeErrorText, normalizeEndDate, eventDays,
} from '@/lib/eventDate'

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

  const { data: event } = await supabaseAdmin
    .from('events')
    .select(`id, organizer_id, submitted_by, organizer_name, title, description, ${EVENT_DATE_COLUMNS}, venue, neighborhood, category, ticket_price, max_tickets, cover_photo, payment_mode, whatsapp_payment_enabled, is_active`)
    .eq('id', params.id)
    .maybeSingle()
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

  // Price + capacity — normalise like the submit route (0/null = free).
  let newPrice: number | null = event.ticket_price
  if ('ticket_price' in body || 'price' in body) {
    const raw = body.ticket_price ?? body.price
    newPrice = raw != null && raw !== '' ? Math.max(0, Math.round(Number(raw))) : null
    updates.ticket_price = newPrice
    updates.price = newPrice // legacy display column kept in sync
  }
  if ('max_tickets' in body) {
    updates.max_tickets = body.max_tickets != null && body.max_tickets !== ''
      ? Math.max(0, parseInt(String(body.max_tickets), 10)) : 0
  }

  // Payment mode — free events are forced to reservation_only + WhatsApp off.
  const effectivePrice = 'ticket_price' in updates ? (updates.ticket_price as number | null) : event.ticket_price
  const isPaid = !!(effectivePrice && effectivePrice > 0)
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
  if ('venue' in updates && (updates.venue ?? null) !== (event.venue ?? null)) changes.venue = true
  if ('ticket_price' in updates && (updates.ticket_price ?? null) !== (event.ticket_price ?? null)) {
    changes.price = { to: (updates.ticket_price as number | null) }
  }

  // notifyEventUpdate writes the event_updated audit row and, when a
  // significant field changed, pings attendees. Pending events have no
  // audience (you can't reserve a draft), so this safely returns 0 for them.
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
