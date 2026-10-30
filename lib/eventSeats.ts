// Event seat counters — server-only. The ONE place seats held by a
// reservation go back into the pool.
//
// Seats live in two counters: events.tickets_sold (the whole event) and
// event_ticket_tiers.sold_count (the tier the reservation bought). Every way
// a reservation stops holding seats — payment failed (lib/payments-settle),
// cancelled, rejected (API routes and the WhatsApp bot) — must give back
// BOTH, exactly once. Cancel and reject used to release only the event
// total, so a tier stayed "sold out" after its tickets were freed.
//
// "Exactly once" comes from closeReservation(): a conditional update that
// only one caller can win, and only the winner releases.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { capacityFromTiers } from '@/lib/eventCapacity'

export interface SeatHolder {
  event_id: string
  quantity: number | null
  tier_id:  string | null
}

// Gives the reservation's seats back to the event total and its tier.
// Read-then-write, like every seat counter in the app (no atomic counter RPC
// yet) — callers make it run once per reservation by winning a claim first.
export async function releaseSeats(r: SeatHolder, now: string = new Date().toISOString()): Promise<void> {
  const qty = Number(r.quantity ?? 0)
  if (qty <= 0) return

  const { data: ev } = await supabaseAdmin
    .from('events').select('tickets_sold').eq('id', r.event_id).maybeSingle()
  const { error: evErr } = await supabaseAdmin
    .from('events')
    .update({ tickets_sold: Math.max(0, Number(ev?.tickets_sold ?? 0) - qty) })
    .eq('id', r.event_id)
  if (evErr) console.error(`[seats] release tickets_sold failed event=${r.event_id}: ${evErr.message}`)

  if (r.tier_id) {
    const { data: tier } = await supabaseAdmin
      .from('event_ticket_tiers').select('sold_count').eq('id', r.tier_id).maybeSingle()
    const { error: tierErr } = await supabaseAdmin
      .from('event_ticket_tiers')
      .update({ sold_count: Math.max(0, Number(tier?.sold_count ?? 0) - qty), updated_at: now })
      .eq('id', r.tier_id)
    if (tierErr) console.error(`[seats] release sold_count failed tier=${r.tier_id}: ${tierErr.message}`)
  }
}

// Statuses that still hold seats and can therefore be cancelled or rejected.
export const OPEN_RESERVATION_STATUSES = ['pending', 'confirmed'] as const

// Moves a reservation that still holds seats to `to` and releases them — in
// that order, and only if THIS call made the transition. A second click, a
// second tab, or an organizer racing the customer gets null and releases
// nothing. A reservation whose MoMo payment is still in flight is never
// closed here: settlement could otherwise pay a cancelled ticket, or release
// its seats a second time when the deposit fails.
//
// Returns the closed row, null when nothing matched, and throws on a
// database error.
export async function closeReservation(
  id: string,
  to: 'cancelled' | 'rejected',
): Promise<(SeatHolder & { id: string }) | null> {
  const now = new Date().toISOString()
  const { data, error } = await supabaseAdmin
    .from('event_reservations')
    .update({ reservation_status: to, updated_at: now })
    .eq('id', id)
    .in('reservation_status', OPEN_RESERVATION_STATUSES as unknown as string[])
    .neq('payment_status', 'pending')
    .select('id, event_id, quantity, tier_id')
    .maybeSingle()
  if (error) throw new Error(`close reservation ${id} → ${to}: ${error.message}`)
  if (!data) return null
  const won = data as SeatHolder & { id: string }
  await releaseSeats(won, now)
  return won
}

// ── Booking: per-day, per-tier capacity (supabase-event-day-capacity.sql) ───
//
// Every new reservation goes through reserve_event_seats(), which locks the
// event row, checks the tier and event caps for THAT day against the rows
// that actually hold seats, bumps the all-days counters and inserts — in one
// transaction. Callers never read-check-insert themselves.

export interface SeatRequestRow {
  customer_id:        string | null
  customer_name:      string
  customer_phone:     string
  quantity:           number
  total_price:        number
  commission_amount:  number
  discount_amount?:   number
  voucher_code?:      string | null
  payment_status:     'not_required' | 'pending'
  payment_id?:        string | null
  payment_method?:    string | null
  reservation_status: 'pending' | 'confirmed'
  reservation_code:   string
  tier_id:            string | null
  tier_name:          string | null
  tier_price:         number | null
}

export interface BookedRow {
  id:               string
  event_id:         string
  event_date:       string
  quantity:         number
  total_price:      number
  tier_id:          string | null
  tier_name:        string | null
  reservation_code: string | null
}

export type ReserveSeatsResult =
  | { ok: true; rows: BookedRow[] }
  | { ok: false; status: number; body: { error: string; remaining?: number; tier_id?: string; state?: 'sold_out' } }

function errorDetail(details: string | null | undefined): { remaining?: number; tier_id?: string } {
  try { return details ? JSON.parse(details) : {} } catch { return {} }
}

export const INFO_ONLY_BOOKING_ERROR = 'Pas de réservation sur Tchop & Ndjoka pour cet événement : voir « Billets / Infos » / No booking on Tchop & Ndjoka for this event: see "Tickets / Info"'

export async function reserveEventSeats(
  eventId: string,
  day: string,
  rows: SeatRequestRow[],
): Promise<ReserveSeatsResult> {
  // I6 backstop: an "Infos seulement" event takes no booking on any path
  // (web, pay, WhatsApp bot).
  const { data: ev } = await supabaseAdmin.from('events').select('booking_mode').eq('id', eventId).maybeSingle()
  if (ev?.booking_mode === 'info') return { ok: false, status: 409, body: { error: INFO_ONLY_BOOKING_ERROR } }
  const { data, error } = await supabaseAdmin.rpc('reserve_event_seats', {
    p_event_id: eventId, p_event_date: day, p_rows: rows,
  })
  if (!error) {
    const booked = (data ?? []) as BookedRow[]
    // Q1: the rows of one booking (one per tier) share one QR — booking_id
    // is the first row's id. Best effort: a failure leaves rows standalone.
    if (booked.length > 0) {
      const { error: bErr } = await supabaseAdmin.from('event_reservations')
        .update({ booking_id: booked[0].id }).in('id', booked.map(r => r.id))
      if (bErr) console.error('[seats] booking_id stamp failed:', bErr.message)
    }
    return { ok: true, rows: booked }
  }

  const d = errorDetail(error.details)
  switch (error.message) {
    case 'tier_sold_out':
      return { ok: false, status: 409, body: {
        error: 'Plus assez de places pour ce tarif ce jour-là / Not enough remaining for this tier on that day',
        remaining: d.remaining ?? 0, tier_id: d.tier_id, state: 'sold_out' } }
    case 'event_sold_out':
      return { ok: false, status: 409, body: {
        error: 'Plus assez de places ce jour-là / Not enough spots remaining on that day',
        remaining: d.remaining ?? 0 } }
    case 'tier_unavailable':
      return { ok: false, status: 409, body: { error: 'Tarif non disponible / Tier not available', tier_id: d.tier_id } }
    case 'invalid_event_date':
      return { ok: false, status: 400, body: { error: 'Choisissez un jour de l\'événement / Pick a day of the event' } }
    case 'past_event_date':
      return { ok: false, status: 409, body: { error: 'Ce jour est passé / That day has passed' } }
    case 'event_not_found':
      return { ok: false, status: 404, body: { error: 'Événement introuvable / Event not found' } }
    case 'invalid_quantity':
    case 'no_rows':
      return { ok: false, status: 400, body: { error: 'Quantité invalide / Invalid quantity' } }
    default:
      console.error('[seats] reserve_event_seats failed event=%s day=%s: %s', eventId, day, error.message)
      return { ok: false, status: 500, body: { error: 'Erreur — réessayez. / Error — please try again.' } }
  }
}

// Availability per day, as the public picker and the organizer panel show
// it. remaining null = unlimited. A day is sold out when the event-wide cap
// is reached, or when every tier is capped and full.
export interface TierDayAvailability {
  tier_id:   string
  capacity:  number
  sold:      number
  remaining: number | null
  soldOut:   boolean
}
export interface DayAvailability {
  date:      string
  past:      boolean
  capacity:  number
  sold:      number
  remaining: number | null
  soldOut:   boolean
  tiers:     TierDayAvailability[]
}

export async function getEventAvailability(eventId: string, today: string): Promise<DayAvailability[] | null> {
  const { data, error } = await supabaseAdmin.rpc('event_availability', { p_event_id: eventId })
  if (error) {
    console.error('[seats] event_availability failed event=%s: %s', eventId, error.message)
    return null
  }
  const left = (capacity: number, sold: number) => capacity > 0 ? Math.max(0, capacity - sold) : null
  const byDay = new Map<string, DayAvailability>()
  for (const r of (data ?? []) as Array<{ day: string; tier_id: string | null; capacity: number; sold: number }>) {
    const day = byDay.get(r.day) ?? {
      date: r.day, past: r.day < today, capacity: 0, sold: 0, remaining: null, soldOut: false, tiers: [],
    }
    if (r.tier_id === null) {
      day.capacity  = r.capacity
      day.sold      = r.sold
      day.remaining = left(r.capacity, r.sold)
    } else {
      const remaining = left(r.capacity, r.sold)
      day.tiers.push({ tier_id: r.tier_id, capacity: r.capacity, sold: r.sold, remaining, soldOut: remaining === 0 })
    }
    byDay.set(r.day, day)
  }
  const days = Array.from(byDay.values())
  for (const d of days) {
    const tierRoom = d.tiers.length === 0 || d.tiers.some(t => !t.soldOut)
    d.soldOut = d.remaining === 0 || !tierRoom
  }
  return days.sort((a, b) => a.date.localeCompare(b.date))
}

// A paid reservation whose MoMo hold had expired before it settled can push a
// day or tier over capacity. The customer paid, so they keep their ticket;
// this reports the overflow so it can be flagged "oversold" for the admin.
export async function reservationOverflow(reservationId: string): Promise<Array<{ day: string; tier_id: string | null; capacity: number; sold: number }>> {
  const { data, error } = await supabaseAdmin.rpc('event_reservation_overflow', { p_reservation_id: reservationId })
  if (error) {
    console.error('[seats] overflow check failed reservation=%s: %s', reservationId, error.message)
    return []
  }
  return (data ?? []) as Array<{ day: string; tier_id: string | null; capacity: number; sold: number }>
}

// Events with tiers: capacity = sum of the ACTIVE tiers' max per day
// (capacityFromTiers). Called after every tier change; returns the new
// capacity, or null when the event has no active tier (capacity is then
// entered by hand and left alone).
export async function syncCapacityFromTiers(eventId: string): Promise<number | null> {
  const { data: tiers, error } = await supabaseAdmin
    .from('event_ticket_tiers').select('max_quantity').eq('event_id', eventId).eq('is_active', true)
  if (error) {
    console.error('[seats] capacity sync: tier read failed event=%s: %s', eventId, error.message)
    return null
  }
  if (!tiers || tiers.length === 0) return null
  const capacity = capacityFromTiers(tiers.map(t => Number(t.max_quantity ?? 0)))
  const { error: upErr } = await supabaseAdmin.from('events').update({ max_tickets: capacity }).eq('id', eventId)
  if (upErr) console.error('[seats] capacity sync: update failed event=%s: %s', eventId, upErr.message)
  return capacity
}

export async function hasActiveTiers(eventId: string): Promise<boolean> {
  const { count } = await supabaseAdmin
    .from('event_ticket_tiers').select('id', { count: 'exact', head: true }).eq('event_id', eventId).eq('is_active', true)
  return (count ?? 0) > 0
}
