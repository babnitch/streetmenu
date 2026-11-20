// Editing a published event, shared by the organiser (PATCH /api/events/[id])
// and the admin « Infos de l'événement » panel (PUT /api/admin/events/[id]/info).
// Same checks for both: a city we serve, the pin inside that city, the end
// after the start, booked days kept, paid tickets only with the module.
// Only the keys sent are changed. One `event_info_changed` audit row with the
// old and new value of every field that changed (the poster and its focus
// keep their own `event_photo_changed` rows).
//
// Attendees: the organiser route pings them when the date / time / venue /
// price changes (notify 'auto'); the admin chooses (notify true / false).

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { normalizeMode, legacyEnabledFromMode } from '@/lib/paymentMode'
import { notifyEventUpdate, ACTIVE_RESERVATION_STATUSES, type SignificantChanges } from '@/lib/directMessaging'
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
import { acceptPosition } from '@/lib/restaurantSignup'

/** "Billets / Infos" link: https?://… without spaces, ≤ 500 characters. */
export function checkInfoLink(raw: unknown): { ok: true; link: string | null } | { ok: false } {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!v) return { ok: true, link: null }
  return /^https?:\/\/\S+$/i.test(v) && v.length <= 500 ? { ok: true, link: v } : { ok: false }
}

/** The event's map pin: inside the city, or null. */
export const acceptEventPin = acceptPosition

// events.lat / events.lng (supabase-event-pin.sql): until the SQL runs the pin
// is neither read nor written. Re-checked every minute.
let pinReady: boolean | null = null
let pinCheckedAt = 0
export async function eventPinReady(): Promise<boolean> {
  if (pinReady !== null && Date.now() - pinCheckedAt < 60_000) return pinReady
  const { error } = await supabaseAdmin.from('events').select('lat, lng').limit(1)
  pinReady = !error
  pinCheckedAt = Date.now()
  return pinReady
}

export const EDIT_BASE_COLUMNS = `id, organizer_id, submitted_by, organizer_name, title, description, ${EVENT_DATE_COLUMNS}, venue, neighborhood, category, ticket_price, max_tickets, cover_photo, payment_mode, whatsapp_payment_enabled, is_active, city, price_is_from, whatsapp, notify_phone, info_link, managed_by_platform, booking_mode, event_status`

type EventRow = {
  id: string; organizer_id: string | null; submitted_by: string | null; organizer_name: string | null; title: string; description: string | null
  date: string; time: string | null; end_date: string | null; end_time: string | null; venue: string | null; neighborhood: string | null
  category: string | null; ticket_price: number | null; max_tickets: number | null; cover_photo: string | null; payment_mode: string | null
  whatsapp_payment_enabled: boolean | null; is_active: boolean; city: string | null; price_is_from: boolean | null; whatsapp: string | null
  notify_phone: string | null; info_link: string | null
  managed_by_platform: boolean | null; booking_mode: string | null; event_status: string | null; cover_focus?: string | null
  lat?: number | null; lng?: number | null
}

/** The event as the edit sees it (pin included once the columns exist). */
export async function loadEventForEdit(id: string): Promise<EventRow | null> {
  const pin = await eventPinReady()
  const { data } = await selectWithFocus('events', `${EDIT_BASE_COLUMNS}${pin ? ', lat, lng' : ''}`,
    cols => supabaseAdmin.from('events').select(cols).eq('id', id).maybeSingle())
  return data as unknown as EventRow | null
}

/** Active bookings (pending / confirmed / attended) of an event. */
export async function activeBookingCount(eventId: string): Promise<number> {
  const { count } = await supabaseAdmin.from('event_reservations').select('id', { count: 'exact', head: true })
    .eq('event_id', eventId).in('reservation_status', ACTIVE_RESERVATION_STATUSES)
  return count ?? 0
}

// Not worth an audit entry of their own: kept in sync with another field.
const DERIVED = new Set(['price', 'payment_enabled', 'blur_hash', 'photo_credit', 'cover_photo', 'cover_focus'])

export interface EditActor { id: string; role: string; isAdmin: boolean }
export interface EditOptions {
  /** Paid modes need the paid_tickets module (always for the admin panel). */
  enforceModules: boolean
  /** 'auto' = ping attendees on a significant change; true / false = the admin's choice. */
  notify: 'auto' | boolean
  /** Admin panel: booking mode, map pin. */
  adminFields: boolean
}

export async function editEvent(event: EventRow, body: Record<string, unknown>, actor: EditActor, opts: EditOptions): Promise<NextResponse> {
  // A rejected (= deleted) event can't be edited.
  if (event.event_status === 'rejected') return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  const updates: Record<string, unknown> = {}
  const bad = (error: string, field: string) => NextResponse.json({ error, field }, { status: 400 })

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
      else return bad('Cadrage invalide / Invalid focus point', 'cover_focus')
    } else updates.cover_focus = null
  }

  // What customers see about who runs it and where: city (a city we serve),
  // « À partir de », the organiser name shown, the public WhatsApp contact.
  if ('city' in body) {
    await getRefData()
    const pick = chooseCity(body.city, undefined)
    if (!pick.ok || pick.proposed) return bad('Ville invalide / Invalid city', 'city')
    updates.city = pick.city
  }
  if ('price_is_from' in body) updates.price_is_from = body.price_is_from === true
  if ('organizer_name' in body) {
    const n = sanitizeText(body.organizer_name, 80)
    if (n.length < 2) return bad('Nom de l\'organisateur requis / Organiser name required', 'organizer_name')
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
      if (!r.ok) return bad(r.error, 'whatsapp')
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
      const intl = /^(\+|00)/.test(raw)
      const r = normalizeTypedPhone(raw, (intl ? detectCountry(raw) : null) ?? (org?.phone ? detectCountry(org.phone) : null) ?? getCountryFromCity(org?.city ?? String(updates.city ?? event.city ?? '')))
      if (!r.ok) return bad(r.error, 'notify_phone')
      updates.notify_phone = org?.phone && samePhone(r.phone, org.phone) ? null : r.phone
    }
  }

  // Admin panel: « Billets / Infos » link, booking mode, map pin.
  if (opts.adminFields) {
    if ('info_link' in body) {
      const l = checkInfoLink(body.info_link)
      if (!l.ok) return bad('Lien invalide (https://…) / Invalid link (https://…)', 'info_link')
      updates.info_link = l.link
    }
    if ('booking_mode' in body) {
      if (body.booking_mode !== 'info' && body.booking_mode !== 'platform') return bad('Mode invalide / Invalid mode', 'booking_mode')
      updates.booking_mode = body.booking_mode
      // Switching to « infos seulement » would strand the people who booked.
      if (body.booking_mode === 'info' && event.booking_mode !== 'info' && await activeBookingCount(event.id) > 0) {
        return NextResponse.json({ error: 'Des personnes ont réservé : annulez leurs réservations avant de passer en « infos seulement ». / People have booked: cancel their bookings before switching to "info only".', field: 'booking_mode' }, { status: 409 })
      }
    }
    const city = String(updates.city ?? event.city ?? '')
    if ('lat' in body || 'lng' in body) {
      if (!(await eventPinReady())) return bad('Position pas encore disponible / Pin not available yet', 'lat')
      if ((body.lat === null || body.lat === '') && (body.lng === null || body.lng === '')) { updates.lat = null; updates.lng = null }
      else {
        await getRefData()
        const pos = acceptEventPin(city, body.lat, body.lng)
        if (!pos) return bad('Position hors de la ville / Pin outside the city', 'lat')
        updates.lat = pos.lat; updates.lng = pos.lng
      }
    } else if ('city' in updates && updates.city !== event.city && event.lat != null && event.lng != null) {
      // New city, old pin elsewhere: the pin goes (the address still shows).
      await getRefData()
      if (!acceptEventPin(city, event.lat, event.lng)) { updates.lat = null; updates.lng = null }
    }
  }

  // Price + capacity — normalise like the submit route (0/null = free).
  let newPrice: number | null = event.ticket_price
  if ('ticket_price' in body || 'price' in body) {
    const raw = body.ticket_price ?? body.price
    newPrice = raw != null && raw !== '' ? Math.max(0, Math.round(Number(raw)) || 0) : null
    updates.ticket_price = newPrice
    updates.price = newPrice // legacy display column kept in sync
  }
  // With tiers, capacity is the sum of their max per day (kept in sync by
  // the tier routes) — a typed value is ignored.
  if ('max_tickets' in body && !(await hasActiveTiers(event.id))) {
    updates.max_tickets = body.max_tickets != null && body.max_tickets !== ''
      ? Math.max(0, parseInt(String(body.max_tickets), 10) || 0) : 0
  }

  // Payment mode — free events are forced to reservation_only + WhatsApp off.
  const effectivePrice = 'ticket_price' in updates ? (updates.ticket_price as number | null) : event.ticket_price
  const isPaid = !!(effectivePrice && effectivePrice > 0)
  // Paid tickets are a module (it costs money): without it a paid mode can't
  // be switched on. An unchanged mode is never refused.
  if (opts.enforceModules && isPaid) {
    const curMode = normalizeMode(event.payment_mode)
    const wantsPaid = ('payment_mode' in body && normalizeMode(body.payment_mode) !== 'reservation_only' && normalizeMode(body.payment_mode) !== curMode)
      || (body.whatsapp_payment_enabled === true && !event.whatsapp_payment_enabled)
    const target = { ...event, booking_mode: String(updates.booking_mode ?? event.booking_mode ?? 'platform') }
    if (wantsPaid && !(await eventAllows(target as never, 'paid_tickets'))) return moduleOffResponse('organizer', 'paid_tickets')
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
    end_date: 'end_date' in body ? ((body.end_date as string) || null) : event.end_date,
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
      console.error('[eventEdit] booked-days check failed:', heldErr.message)
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
    console.error('[eventEdit] update failed:', updErr?.message)
    return NextResponse.json({ error: updErr?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  if (singleDayMove) {
    const { error: moveErr } = await supabaseAdmin
      .from('event_reservations')
      .update({ event_date: newDays[0], updated_at: new Date().toISOString() })
      .eq('event_id', event.id)
      .eq('event_date', oldDays[0])
    if (moveErr) console.error('[eventEdit] moving bookings %s → %s failed:', oldDays[0], newDays[0], moveErr.message)
    else console.log('[eventEdit] event=%s bookings moved %s → %s', event.id, oldDays[0], newDays[0])
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

  const performedByType = actor.isAdmin ? actor.role : 'organiser'
  // The poster and its focus point: one audit row per field changed.
  for (const field of ['cover_photo', 'cover_focus'] as const) {
    if (!(field in updates)) continue
    const old = (event[field] ?? null) as string | null
    if ((updates[field] ?? null) === old) continue
    await writeAudit({
      action: 'event_photo_changed', targetType: 'event', targetId: event.id,
      performedBy: actor.id, performedByType,
      previousData: { [field]: old }, metadata: { field, old, new: updates[field] ?? null, title: event.title },
    })
  }
  // Every other field: one row, old → new.
  const diff: Record<string, { old: unknown; new: unknown }> = {}
  for (const [k, v] of Object.entries(updates)) {
    if (DERIVED.has(k)) continue
    const old = (event as unknown as Record<string, unknown>)[k] ?? null
    if ((v ?? null) !== old) diff[k] = { old, new: v ?? null }
  }
  if (Object.keys(diff).length > 0) {
    await writeAudit({
      action: 'event_info_changed', targetType: 'event', targetId: event.id,
      performedBy: actor.id, performedByType,
      previousData: Object.fromEntries(Object.entries(diff).map(([k, d]) => [k, d.old])),
      metadata: { title: event.title, changes: diff, via: opts.adminFields ? 'admin_panel' : 'organiser' },
    })
  }

  // notifyEventUpdate writes the event_updated audit row and, when a
  // significant field changed and sending is on, pings attendees. Pending
  // events have no audience (you can't reserve a draft) → 0.
  const notified = await notifyEventUpdate(
    {
      id: updated.id, title: updated.title, date: updated.date, time: updated.time,
      end_date: updated.end_date, end_time: updated.end_time, venue: updated.venue,
    },
    changes,
    actor.id,
    actor.role,
    opts.notify !== false,
  )

  return NextResponse.json({ updated: true, notified_count: notified, changed: Object.keys(diff) })
}
