// Event-tier helpers shared by the API + the UI cards.
//
// The tier model is fully backward-compatible: events with zero rows
// in event_ticket_tiers fall back to events.ticket_price + max_tickets.
// Once at least one active tier exists, the tier records become the
// source of truth for price + capacity gates.

import { supabaseAdmin } from '@/lib/supabaseAdmin'

export interface TicketTier {
  id:           string
  event_id:     string
  name:         string
  name_en:      string | null
  price:        number
  max_quantity: number          // 0 = unlimited
  sold_count:   number
  sort_order:   number
  is_active:    boolean
  sales_start:  string | null
  sales_end:    string | null
  description:  string | null
  created_at:   string
  updated_at:   string
}

// Lifecycle for the public picker:
//   upcoming   — sales_start is in the future
//   active     — currently on sale
//   expired    — sales_end is in the past
//   sold_out   — max_quantity hit
//   inactive   — soft-deleted by the organizer
//
// The picker hides expired + inactive tiers; the others render but with
// disabled buttons + a status badge.
export type TierAvailability =
  | { kind: 'active';   remaining: number | null }
  | { kind: 'upcoming'; startsAt: string }
  | { kind: 'expired' }
  | { kind: 'sold_out' }
  | { kind: 'inactive' }

// Capacity is per DAY (supabase-event-day-capacity.sql): tier.sold_count is an
// all-days total for dashboards and decides nothing. Pass `soldOnDay` (from
// event_availability) to include capacity; without it only the lifecycle is
// checked and `remaining` is null — the booking itself is capacity-checked
// atomically by reserve_event_seats.
export function tierAvailability(
  tier: TicketTier,
  nowISO: string = new Date().toISOString(),
  soldOnDay?: number,
): TierAvailability {
  if (!tier.is_active) return { kind: 'inactive' }
  const now = new Date(nowISO).getTime()
  if (tier.sales_start && new Date(tier.sales_start).getTime() > now) {
    return { kind: 'upcoming', startsAt: tier.sales_start }
  }
  if (tier.sales_end && new Date(tier.sales_end).getTime() < now) {
    return { kind: 'expired' }
  }
  if (soldOnDay === undefined || tier.max_quantity <= 0) return { kind: 'active', remaining: null }
  if (soldOnDay >= tier.max_quantity) return { kind: 'sold_out' }
  return { kind: 'active', remaining: tier.max_quantity - soldOnDay }
}

// Server-side fetch — used by the public event-detail page (anon-safe).
// Hidden tiers (inactive + expired) are filtered here so the API never
// leaks them to clients.
export async function getPublicTiersForEvent(eventId: string): Promise<TicketTier[]> {
  const { data, error } = await supabaseAdmin
    .from('event_ticket_tiers')
    .select('*')
    .eq('event_id', eventId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[tiers] getPublicTiersForEvent failed:', error.message)
    return []
  }
  const now = new Date().toISOString()
  return ((data ?? []) as TicketTier[]).filter(t => {
    const a = tierAvailability(t, now)
    return a.kind !== 'expired' && a.kind !== 'inactive'
  })
}

// Organizer-side fetch (includes inactive + expired). Used by the
// dashboard tier-management panel.
export async function getAllTiersForEvent(eventId: string): Promise<TicketTier[]> {
  const { data, error } = await supabaseAdmin
    .from('event_ticket_tiers')
    .select('*')
    .eq('event_id', eventId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) return []
  return (data ?? []) as TicketTier[]
}

// Price-range summary for an events-list card. Returns a structured
// shape so callers can localise the formatting.
//
// - hasTiers=false → caller renders the single ticket_price as before.
// - allFree        → "Gratuit / Free"
// - singlePrice    → "5,000 FCFA"
// - range          → "1,500 - 5,000 FCFA"
// - mixed (one free, others paid) → " Gratuit - 5,000 FCFA"
export interface PriceSummary {
  hasTiers:    boolean
  allFree:     boolean
  freeMixed:   boolean         // at least one free + at least one paid
  minPaid:     number          // 0 when no paid tiers
  maxPaid:     number
  fallbackPrice: number | null // events.ticket_price for the non-tier path
}

export function summarisePrice(
  tiers: Array<Pick<TicketTier, 'price' | 'is_active'>>,
  fallbackPrice: number | null,
): PriceSummary {
  const active = tiers.filter(t => t.is_active)
  if (active.length === 0) {
    return { hasTiers: false, allFree: false, freeMixed: false, minPaid: 0, maxPaid: 0, fallbackPrice }
  }
  const paid = active.filter(t => t.price > 0).map(t => t.price)
  const allFree = paid.length === 0
  const freeMixed = paid.length > 0 && active.some(t => t.price === 0)
  return {
    hasTiers:  true,
    allFree,
    freeMixed,
    minPaid:   paid.length ? Math.min(...paid) : 0,
    maxPaid:   paid.length ? Math.max(...paid) : 0,
    fallbackPrice,
  }
}

// True once the event has at least one active tier: from then on the tiers
// set the price, and a booking without one is refused (V0) — the event's own
// ticket_price may be 0 or out of date.
export async function hasActiveTiers(eventId: string): Promise<boolean> {
  const { count } = await supabaseAdmin
    .from('event_ticket_tiers').select('id', { count: 'exact', head: true })
    .eq('event_id', eventId).eq('is_active', true)
  return (count ?? 0) > 0
}

export const PICK_TIER_ERROR = 'Choisissez un type de billet / Pick a ticket type'

// The page's total against the server's. Only checked when the page sends
// one — the server's own total is what gets booked and charged either way.
export function totalMismatch(expected: unknown, serverTotal: number): boolean {
  if (expected === undefined || expected === null || expected === '') return false
  const n = Math.round(Number(expected))
  return !Number.isFinite(n) || n !== serverTotal
}

export const PRICE_CHANGED_BOOKING_TEXT =
  'Le prix a changé. Rechargez la page et vérifiez le total. / The price has changed. Reload the page and check the total.'
