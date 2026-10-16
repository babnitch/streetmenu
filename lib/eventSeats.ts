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
