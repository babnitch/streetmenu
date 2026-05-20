// Promotions / native-ad helpers (server-only).

import { supabaseAdmin } from '@/lib/supabaseAdmin'

export type Placement   = 'top_list' | 'feed_card' | 'banner'
export type TargetType  = 'restaurant' | 'event'
export type PromoStatus = 'draft' | 'pending_review' | 'active' | 'paused' | 'completed' | 'rejected'

export const PLACEMENTS: Placement[] = ['top_list', 'feed_card', 'banner']

// Hard cap so a vendor can't flood the feed with their own listings.
export const MAX_PROMOS_PER_PAGE = 2

// Position cadence per placement — controls where feed-card promos are
// injected into the regular list.
export const FEED_INJECT_EVERY_RESTAURANT = 5
export const FEED_INJECT_EVERY_EVENT      = 4

// ── Pricing ─────────────────────────────────────────────────────────────────

export interface PromotionPricingRow {
  placement:         Placement
  price_per_day:     number
  min_duration_days: number
  max_duration_days: number
}

export async function getActivePricing(): Promise<Record<Placement, PromotionPricingRow>> {
  const { data } = await supabaseAdmin
    .from('promotion_pricing')
    .select('placement, price_per_day, min_duration_days, max_duration_days')
    .eq('is_active', true)
  const fallback: Record<Placement, PromotionPricingRow> = {
    top_list:  { placement: 'top_list',  price_per_day: 2000, min_duration_days: 1, max_duration_days: 30 },
    feed_card: { placement: 'feed_card', price_per_day: 1000, min_duration_days: 1, max_duration_days: 30 },
    banner:    { placement: 'banner',    price_per_day: 500,  min_duration_days: 1, max_duration_days: 30 },
  }
  for (const row of (data ?? []) as PromotionPricingRow[]) {
    fallback[row.placement] = row
  }
  return fallback
}

// Inclusive day count between start and end. Same calendar day = 1 day,
// not 0, so a "buy for today" promotion costs one full day.
export function daysBetween(startISO: string, endISO: string): number {
  const start = new Date(startISO)
  const end   = new Date(endISO)
  const ms    = end.getTime() - start.getTime()
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)) + 1)
}

export function computeCost(
  placement: Placement,
  startISO: string,
  endISO: string,
  pricing: Record<Placement, PromotionPricingRow>,
): { days: number; cost: number; perDay: number } {
  const days   = daysBetween(startISO, endISO)
  const perDay = pricing[placement].price_per_day
  return { days, cost: days * perDay, perDay }
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export interface PromoteEligibility {
  asPublisher:   boolean
  restaurants:   Array<{ id: string; name: string; city: string }>
  events:        Array<{ id: string; title: string; city: string }>
}

// Restaurant owners can promote their own approved restaurants. Verified
// event publishers (auto-approve flag OR at least one approved event)
// can promote their own active events.
export async function getPromotionEligibility(customerId: string): Promise<PromoteEligibility> {
  const [{ data: customer }, { data: rests }, { data: events }] = await Promise.all([
    supabaseAdmin
      .from('customers')
      .select('event_auto_approve, events_approved_count')
      .eq('id', customerId)
      .maybeSingle(),
    supabaseAdmin
      .from('restaurants')
      .select('id, name, city, status, deleted_at')
      .eq('customer_id', customerId),
    supabaseAdmin
      .from('events')
      .select('id, title, city, is_active, organizer_id')
      .eq('organizer_id', customerId)
      .eq('is_active', true),
  ])

  const restaurants = ((rests ?? []) as Array<{ id: string; name: string; city: string; status: string | null; deleted_at: string | null }>)
    .filter(r => !r.deleted_at && (r.status === 'active' || r.status === 'approved'))
    .map(r => ({ id: r.id, name: r.name, city: r.city }))

  const verifiedPublisher = !!customer && (
    customer.event_auto_approve === true ||
    (customer.events_approved_count ?? 0) >= 1
  )

  return {
    asPublisher: verifiedPublisher,
    restaurants,
    events: ((events ?? []) as Array<{ id: string; title: string; city: string }>),
  }
}

// ── Active-promotion fetch (display path) ──────────────────────────────────

export interface ActivePromotion {
  id:              string
  promoter_id:     string
  target_type:     TargetType
  target_id:       string
  placement:       Placement
  city:            string
  start_date:      string
  end_date:        string
}

// Pull "active right now" promotions for a city + target type. Caller
// passes `viewerCustomerId` so promoters never see their own ads
// (impressions would inflate dishonestly otherwise).
export async function getActivePromotions(opts: {
  city:        string
  targetType:  TargetType
  placement?:  Placement
  viewerCustomerId?: string | null
}): Promise<ActivePromotion[]> {
  const now = new Date().toISOString()
  let q = supabaseAdmin
    .from('promotions')
    .select('id, promoter_id, target_type, target_id, placement, city, start_date, end_date')
    .eq('status', 'active')
    .eq('payment_status', 'paid')
    .eq('city', opts.city)
    .eq('target_type', opts.targetType)
    .lte('start_date', now)
    .gte('end_date', now)
  if (opts.placement) q = q.eq('placement', opts.placement)

  const { data, error } = await q
  if (error) {
    console.error('[promotions] getActivePromotions failed:', error.message)
    return []
  }
  const rows = (data ?? []) as ActivePromotion[]
  if (opts.viewerCustomerId) {
    return rows.filter(r => r.promoter_id !== opts.viewerCustomerId)
  }
  return rows
}

// ── Display injection ───────────────────────────────────────────────────────

// Given a base list of items and the promoted overrides, returns the
// list with top-list promos pinned to the front and feed-card promos
// injected every N positions. Caps the total promos at MAX_PROMOS_PER_PAGE.
//
// Items in the base list are matched against promos by `getId(item)`.
// Promoted items already present in the base list keep their boosted
// position — we don't duplicate them.
export function arrangePromoted<T>(
  base: T[],
  promos: Array<{ id: string; target_id: string; placement: Placement }>,
  resolveItem: (targetId: string) => T | null,
  getId: (item: T) => string,
  feedEvery: number,
): Array<{ item: T; promotionId?: string }> {
  const taken: Array<{ item: T; promotionId?: string }> = []
  let injected = 0

  // 1) Pin top_list first (max MAX_PROMOS_PER_PAGE total across both)
  for (const p of promos) {
    if (p.placement !== 'top_list') continue
    if (injected >= MAX_PROMOS_PER_PAGE) break
    const it = resolveItem(p.target_id)
    if (!it) continue
    taken.push({ item: it, promotionId: p.id })
    injected++
  }

  const alreadyShownIds = new Set(taken.map(t => getId(t.item)))

  // 2) Regular feed; inject feed_card promos every `feedEvery` positions
  const feedCardQueue = promos
    .filter(p => p.placement === 'feed_card')
    .map(p => ({ p, item: resolveItem(p.target_id) }))
    .filter(({ item }) => !!item) as Array<{ p: typeof promos[number]; item: T }>

  let cursor = 0
  for (const baseItem of base) {
    if (alreadyShownIds.has(getId(baseItem))) continue
    taken.push({ item: baseItem })
    cursor++
    if (cursor % feedEvery === 0 && injected < MAX_PROMOS_PER_PAGE && feedCardQueue.length > 0) {
      const next = feedCardQueue.shift()!
      if (!alreadyShownIds.has(getId(next.item))) {
        taken.push({ item: next.item, promotionId: next.p.id })
        alreadyShownIds.add(getId(next.item))
        injected++
      }
    }
  }

  return taken
}
