// TEST-PLAN.md §1a #3, #5, #6, #7, #8, #9, #13, #14, #15.
//
// Everything money-, mode- or scoring-shaped that needs no I/O. These modules
// import lib/supabaseAdmin, but that client is lazily built behind a Proxy —
// nothing here touches it, so the suite runs with no credentials.

import { validatePrepTime, formatPrepTime, PREP_TIME_MIN_FLOOR, PREP_TIME_MAX_CEIL } from '@/lib/prepTime'
import {
  normalizeMode, modeFromLegacy, legacyEnabledFromMode,
  canPayOnline, canReserve, effectiveWebMode, effectiveWhatsAppMode,
  PAYMENT_MODES, DEFAULT_PAYMENT_MODE, type PaymentMode,
} from '@/lib/paymentMode'
import { computeDiscount, deriveStatus, isPercentDiscount } from '@/lib/vouchers'
import { tierAvailability, summarisePrice, type TicketTier } from '@/lib/tiers'
import { daysBetween, computeCost, arrangePromoted, MAX_PROMOS_PER_PAGE, type PromotionPricingRow, type Placement } from '@/lib/promotions'
import { tagsForRating, sanitizeTags, aggregate, POSITIVE_TAGS, NEGATIVE_TAGS } from '@/lib/ratings'
import { computeBroadcastCost, formatBroadcastMessage } from '@/lib/subscriptions'
import { rateLimit } from '@/lib/rateLimit'
import { randomReservationCode } from '@/lib/reservationCode'
import { assert, assertEq, assertIncludes, step, finish } from '../testkit/assert'

const SUITE = 'unit-pricing-and-modes'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function tier(over: Partial<TicketTier> = {}): TicketTier {
  return {
    id: 't1', event_id: 'e1', name: 'Standard', name_en: null,
    price: 1000, max_quantity: 0, sold_count: 0, sort_order: 0,
    is_active: true, sales_start: null, sales_end: null, description: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

const PRICING: Record<Placement, PromotionPricingRow> = {
  top_list:  { placement: 'top_list',  price_per_day: 100, min_duration_days: 1, max_duration_days: 30 },
  feed_card: { placement: 'feed_card', price_per_day: 250, min_duration_days: 1, max_duration_days: 30 },
  banner:    { placement: 'banner',    price_per_day: 500, min_duration_days: 1, max_duration_days: 30 },
}

async function main(): Promise<void> {
  // ── #3 prep time ──────────────────────────────────────────────────────────
  await step('formatPrepTime', () => {
    assertEq(formatPrepTime(20, 35), '20-35 min', 'the default range renders as "20-35 min"')
    assertEq(formatPrepTime(5, 120), '5-120 min', 'the full legal span renders')
    assertEq(formatPrepTime(null, 35), null, 'a null min hides the badge')
    assertEq(formatPrepTime(20, null), null, 'a null max hides the badge')
    assertEq(formatPrepTime(null, null), null, 'both null hides the badge')
    assertEq(formatPrepTime(undefined, undefined), null, 'both undefined hides the badge')
    assertEq(formatPrepTime(NaN, 35), null, 'a non-finite min hides the badge')
    assertEq(formatPrepTime(20, Infinity), null, 'a non-finite max hides the badge')
  })

  await step('validatePrepTime', () => {
    const ok = validatePrepTime(20, 35)
    assert(ok.ok, 'the default 20/35 pair is valid')
    assertEq(ok.min, 20, 'min is echoed back')
    assertEq(ok.max, 35, 'max is echoed back')

    assert(validatePrepTime(PREP_TIME_MIN_FLOOR, 10).ok, `min at the floor (${PREP_TIME_MIN_FLOOR}) is allowed`)
    assert(validatePrepTime(10, PREP_TIME_MAX_CEIL).ok, `max at the ceiling (${PREP_TIME_MAX_CEIL}) is allowed`)

    const belowFloor = validatePrepTime(4, 30)
    assert(!belowFloor.ok, 'min below the floor is rejected')
    assertIncludes(belowFloor.error, '5', 'the floor error names the floor')

    const aboveCeil = validatePrepTime(10, 121)
    assert(!aboveCeil.ok, 'max above the ceiling is rejected')
    assertIncludes(aboveCeil.error, '120', 'the ceiling error names the ceiling')

    const inverted = validatePrepTime(40, 20)
    assert(!inverted.ok, 'min greater than max is rejected')
    assertIncludes(inverted.error, 'minimum', 'the ordering error mentions the minimum')
    assert(!validatePrepTime(20, 20).ok, 'min equal to max is rejected')

    assert(!validatePrepTime(20.5, 35).ok, 'a fractional min is rejected')
    assert(!validatePrepTime('abc', 35).ok, 'a non-numeric min is rejected')
    assert(!validatePrepTime(null, 35).ok, 'a null min is rejected')
    assert(!validatePrepTime(undefined, undefined).ok, 'undefined pair is rejected')
    assert(validatePrepTime('20', '35').ok, 'numeric strings are coerced and accepted')
  })

  // ── #5 payment modes ──────────────────────────────────────────────────────
  await step('normalizeMode', () => {
    assertEq(normalizeMode('payment_only'), 'payment_only', 'payment_only passes through')
    assertEq(normalizeMode('both'), 'both', 'both passes through')
    assertEq(normalizeMode('reservation_only'), 'reservation_only', 'reservation_only passes through')
    assertEq(normalizeMode('nonsense'), 'reservation_only', 'an unknown string falls back to the safe default')
    assertEq(normalizeMode(null), 'reservation_only', 'null falls back')
    assertEq(normalizeMode(undefined), 'reservation_only', 'undefined falls back')
    assertEq(normalizeMode(42), 'reservation_only', 'a number falls back')
    assertEq(normalizeMode(DEFAULT_PAYMENT_MODE), DEFAULT_PAYMENT_MODE, 'the exported default is itself valid')
    assertEq(PAYMENT_MODES.length, 3, 'there are exactly three modes')
  })

  await step('modeFromLegacy ⇄ legacyEnabledFromMode round-trip', () => {
    assertEq(modeFromLegacy(true), 'both', 'legacy payment_enabled=true → both')
    assertEq(modeFromLegacy(false), 'reservation_only', 'legacy false → reservation_only')
    assertEq(modeFromLegacy(null), 'reservation_only', 'legacy null → reservation_only')
    assertEq(modeFromLegacy(undefined), 'reservation_only', 'legacy undefined → reservation_only')

    assertEq(legacyEnabledFromMode('payment_only'), true, 'payment_only keeps the legacy flag on')
    assertEq(legacyEnabledFromMode('both'), true, 'both keeps the legacy flag on')
    assertEq(legacyEnabledFromMode('reservation_only'), false, 'reservation_only turns it off')

    // The bridge only has to round-trip the two modes legacy could express.
    assertEq(modeFromLegacy(legacyEnabledFromMode('both')), 'both', 'both survives the round trip')
    assertEq(modeFromLegacy(legacyEnabledFromMode('reservation_only')), 'reservation_only',
      'reservation_only survives the round trip')
  })

  await step('canPayOnline / canReserve — the 3-way matrix', () => {
    const table: Array<[PaymentMode, boolean, boolean]> = [
      ['payment_only',     true,  false],
      ['reservation_only', false, true],
      ['both',             true,  true],
    ]
    for (const [mode, pay, reserve] of table) {
      assertEq(canPayOnline(mode), pay, `canPayOnline(${mode}) === ${pay}`)
      assertEq(canReserve(mode), reserve, `canReserve(${mode}) === ${reserve}`)
      assert(canPayOnline(mode) || canReserve(mode), `${mode} always offers at least one path`)
    }
  })

  await step('effectiveWebMode — free events force reservation_only', () => {
    for (const mode of PAYMENT_MODES) {
      assertEq(effectiveWebMode(mode, false), mode, `paid event keeps ${mode}`)
      assertEq(effectiveWebMode(mode, true), 'reservation_only', `free event collapses ${mode} to reservation_only`)
    }
    assertEq(effectiveWebMode('both'), 'both', 'isFree defaults to false')
  })

  await step('effectiveWhatsAppMode — flag gates payment independently of the web mode', () => {
    for (const mode of PAYMENT_MODES) {
      assertEq(effectiveWhatsAppMode(mode, true, false), mode,
        `flag on, paid: WhatsApp follows the web mode (${mode})`)
      assertEq(effectiveWhatsAppMode(mode, false, false), 'reservation_only',
        `flag off collapses ${mode} to reservation_only`)
      assertEq(effectiveWhatsAppMode(mode, true, true), 'reservation_only',
        `free event collapses ${mode} even with the flag on`)
      assertEq(effectiveWhatsAppMode(mode, false, true), 'reservation_only',
        `free event with the flag off is reservation_only (${mode})`)
    }
    assertEq(effectiveWhatsAppMode('both', true), 'both', 'isFree defaults to false here too')
  })

  // ── #6 voucher discount ───────────────────────────────────────────────────
  await step('isPercentDiscount accepts the stored aliases', () => {
    for (const v of ['percent', 'percentage', '%', 'PERCENT', '  Percent  ']) {
      assert(isPercentDiscount(v), `"${v}" reads as percent`)
    }
    for (const v of ['fixed', 'amount', '', null, undefined]) {
      assert(!isPercentDiscount(v as string), `${JSON.stringify(v)} does not read as percent`)
    }
  })

  await step('computeDiscount — percent', () => {
    assertEq(computeDiscount({ discount_type: 'percent', discount_value: 10 }, 5000), 500, '10% of 5000')
    // 'percentage' is an alias isPercentDiscount honours at runtime but the
    // VoucherRow type does not spell out — the cast is the point of the case.
    assertEq(computeDiscount({ discount_type: 'percentage' as 'percent', discount_value: 10 }, 5000), 500,
      'the alias behaves identically')
    assertEq(computeDiscount({ discount_type: 'percent', discount_value: 100 }, 5000), 5000, '100% is the whole total')
    assertEq(computeDiscount({ discount_type: 'percent', discount_value: 150 }, 5000), 5000, 'above 100% clamps at the total')
    assertEq(computeDiscount({ discount_type: 'percent', discount_value: -10 }, 5000), 0, 'a negative percent clamps at 0')
    assertEq(computeDiscount({ discount_type: 'percent', discount_value: 0 }, 5000), 0, '0% is 0')
    // 3333 * 0.10 = 333.3 → rounds to 333
    assertEq(computeDiscount({ discount_type: 'percent', discount_value: 10 }, 3333), 333, 'rounds to the nearest franc (down)')
    // 3335 * 0.15 = 500.25 → 500
    assertEq(computeDiscount({ discount_type: 'percent', discount_value: 15 }, 3335), 500, 'rounds to the nearest franc')
    assertEq(computeDiscount({ discount_type: 'percent', discount_value: 10 }, 0), 0, 'a zero total discounts nothing')
  })

  await step('computeDiscount — fixed', () => {
    assertEq(computeDiscount({ discount_type: 'fixed', discount_value: 500 }, 5000), 500, 'a fixed amount under the total')
    assertEq(computeDiscount({ discount_type: 'fixed', discount_value: 5000 }, 5000), 5000, 'exactly the total')
    assertEq(computeDiscount({ discount_type: 'fixed', discount_value: 9000 }, 5000), 5000,
      'a discount larger than the total clamps at the total — never negative')
    assertEq(computeDiscount({ discount_type: 'fixed', discount_value: -500 }, 5000), 0, 'a negative amount clamps at 0')
    assertEq(computeDiscount({ discount_type: 'fixed', discount_value: 499.6 }, 5000), 500, 'a fractional amount is rounded')
    assertEq(computeDiscount({ discount_type: 'fixed', discount_value: 500 }, 0), 0, 'nothing to discount on a zero total')
  })

  await step('deriveStatus', () => {
    const base = { is_active: true, expires_at: null, max_uses: null, current_uses: 0 }
    assertEq(deriveStatus(base), 'active', 'a live unlimited voucher is active')
    assertEq(deriveStatus({ ...base, is_active: false }), 'inactive', 'is_active=false wins over everything')
    assertEq(deriveStatus({ ...base, is_active: false, expires_at: '2000-01-01T00:00:00Z' }), 'inactive',
      'inactive is checked before expired')
    assertEq(deriveStatus({ ...base, expires_at: '2000-01-01T00:00:00Z' }), 'expired', 'a past expiry is expired')
    assertEq(deriveStatus({ ...base, expires_at: '2999-01-01T00:00:00Z' }), 'active', 'a future expiry is still active')
    assertEq(deriveStatus({ ...base, max_uses: 5, current_uses: 5 }), 'exhausted', 'uses equal to the cap is exhausted')
    assertEq(deriveStatus({ ...base, max_uses: 5, current_uses: 6 }), 'exhausted', 'over the cap is exhausted')
    assertEq(deriveStatus({ ...base, max_uses: 5, current_uses: 4 }), 'active', 'under the cap is active')
    assertEq(deriveStatus({ ...base, max_uses: 0, current_uses: 999 }), 'active', 'max_uses=0 means unlimited')
    assertEq(deriveStatus({ ...base, max_uses: null, current_uses: 999 }), 'active', 'max_uses=null means unlimited')
    assertEq(deriveStatus({ ...base, max_uses: 5, current_uses: null as unknown as number }), 'active',
      'a null current_uses counts as 0')
    assertEq(deriveStatus({ ...base, expires_at: '2000-01-01T00:00:00Z', max_uses: 1, current_uses: 5 }), 'expired',
      'expired is checked before exhausted')
  })

  // ── #7 ticket tiers ───────────────────────────────────────────────────────
  await step('tierAvailability', () => {
    const now = '2026-06-15T12:00:00Z'

    const active = tierAvailability(tier(), now)
    assertEq(active.kind, 'active', 'a plain tier is active')
    assertEq(active.kind === 'active' ? active.remaining : 'n/a', null, 'unlimited stock reports null remaining')

    const limited = tierAvailability(tier({ max_quantity: 10, sold_count: 3 }), now)
    assertEq(limited.kind, 'active', 'a partly sold tier is still active')
    assertEq(limited.kind === 'active' ? limited.remaining : -1, 7, 'remaining is max minus sold')

    assertEq(tierAvailability(tier({ is_active: false }), now).kind, 'inactive', 'soft-deleted → inactive')
    assertEq(tierAvailability(tier({ is_active: false, max_quantity: 1, sold_count: 5 }), now).kind, 'inactive',
      'inactive is checked before sold_out')

    assertEq(tierAvailability(tier({ max_quantity: 5, sold_count: 5 }), now).kind, 'sold_out', 'sold to the cap → sold_out')
    assertEq(tierAvailability(tier({ max_quantity: 5, sold_count: 9 }), now).kind, 'sold_out', 'oversold → sold_out')

    const upcoming = tierAvailability(tier({ sales_start: '2026-07-01T00:00:00Z' }), now)
    assertEq(upcoming.kind, 'upcoming', 'a future sales_start → upcoming')
    assertEq(upcoming.kind === 'upcoming' ? upcoming.startsAt : '', '2026-07-01T00:00:00Z', 'and it reports when')

    assertEq(tierAvailability(tier({ sales_end: '2026-01-01T00:00:00Z' }), now).kind, 'expired',
      'a past sales_end → expired')
    assertEq(tierAvailability(tier({ sales_start: '2026-01-01T00:00:00Z', sales_end: '2026-12-31T00:00:00Z' }), now).kind,
      'active', 'inside an explicit sales window → active')
    assertEq(tierAvailability(tier({ sales_start: '2026-07-01T00:00:00Z', sales_end: '2026-01-01T00:00:00Z' }), now).kind,
      'upcoming', 'upcoming is checked before expired')
  })

  await step('summarisePrice', () => {
    const none = summarisePrice([], 3000)
    assertEq(none.hasTiers, false, 'no tiers → hasTiers false')
    assertEq(none.fallbackPrice, 3000, 'and the event ticket_price is carried through')

    const inactiveOnly = summarisePrice([{ price: 1000, is_active: false }], 3000)
    assertEq(inactiveOnly.hasTiers, false, 'only-inactive tiers count as no tiers')

    const single = summarisePrice([{ price: 5000, is_active: true }], null)
    assertEq(single.hasTiers, true, 'one active tier → hasTiers')
    assertEq(single.minPaid, 5000, 'min equals the single price')
    assertEq(single.maxPaid, 5000, 'max equals the single price')
    assertEq(single.allFree, false, 'a paid tier is not all-free')
    assertEq(single.freeMixed, false, 'and not mixed')

    const range = summarisePrice([
      { price: 1500, is_active: true }, { price: 5000, is_active: true }, { price: 3000, is_active: true },
    ], null)
    assertEq(range.minPaid, 1500, 'range min')
    assertEq(range.maxPaid, 5000, 'range max')

    const allFree = summarisePrice([{ price: 0, is_active: true }, { price: 0, is_active: true }], null)
    assertEq(allFree.allFree, true, 'every tier free → allFree')
    assertEq(allFree.freeMixed, false, 'all-free is not mixed')
    assertEq(allFree.minPaid, 0, 'no paid tiers → minPaid 0')

    const mixed = summarisePrice([{ price: 0, is_active: true }, { price: 5000, is_active: true }], null)
    assertEq(mixed.freeMixed, true, 'one free plus one paid → freeMixed')
    assertEq(mixed.allFree, false, 'mixed is not allFree')
    assertEq(mixed.minPaid, 5000, 'minPaid ignores the free tier')

    const filtered = summarisePrice([{ price: 100, is_active: false }, { price: 5000, is_active: true }], null)
    assertEq(filtered.minPaid, 5000, 'inactive tiers are excluded from the range')
  })

  // ── #8 promotions ─────────────────────────────────────────────────────────
  await step('daysBetween is inclusive of both ends', () => {
    assertEq(daysBetween('2026-01-01', '2026-01-01'), 1, 'a single day counts as 1')
    assertEq(daysBetween('2026-01-01', '2026-01-02'), 2, 'two consecutive days count as 2')
    assertEq(daysBetween('2026-01-01', '2026-01-03'), 3, 'a three-day span counts as 3')
    assertEq(daysBetween('2026-01-01', '2026-01-31'), 31, 'a full month')
    assertEq(daysBetween('2026-01-03', '2026-01-01'), 1, 'a reversed range floors at 1, never negative')
  })

  await step('computeCost', () => {
    const c = computeCost('feed_card', '2026-01-01', '2026-01-03', PRICING)
    assertEq(c.days, 3, 'days come from daysBetween')
    assertEq(c.perDay, 250, 'perDay comes from the pricing row')
    assertEq(c.cost, 750, 'cost is days × perDay')

    assertEq(computeCost('top_list', '2026-01-01', '2026-01-01', PRICING).cost, 100, 'a one-day top_list')
    assertEq(computeCost('banner', '2026-01-01', '2026-01-10', PRICING).cost, 5000, 'a ten-day banner')
    for (const p of ['top_list', 'feed_card', 'banner'] as Placement[]) {
      assertEq(computeCost(p, '2026-01-01', '2026-01-02', PRICING).cost, PRICING[p].price_per_day * 2,
        `${p} priced from its own row`)
    }
  })

  await step('arrangePromoted', () => {
    type It = { id: string }
    const base: It[] = Array.from({ length: 12 }, (_, i) => ({ id: `b${i + 1}` }))
    const pool: Record<string, It> = {}
    for (const b of base) pool[b.id] = b
    pool.p1 = { id: 'p1' }; pool.p2 = { id: 'p2' }; pool.p3 = { id: 'p3' }
    const resolve = (t: string): It | null => pool[t] ?? null
    const getId = (i: It) => i.id
    const ids = (r: Array<{ item: It; promotionId?: string }>) => r.map(x => (x.promotionId ? `${x.item.id}*` : x.item.id))

    assertEq(ids(arrangePromoted(base, [], resolve, getId, 5)), base.map(getId),
      'no promotions leaves the feed untouched')

    assertEq(ids(arrangePromoted(base, [{ id: 'A', target_id: 'p1', placement: 'top_list' }], resolve, getId, 5))[0],
      'p1*', 'a top_list promo is pinned first and tagged with its promotion id')

    const threeTop = arrangePromoted(
      base, [1, 2, 3].map(n => ({ id: `A${n}`, target_id: `p${n}`, placement: 'top_list' as const })),
      resolve, getId, 5,
    )
    assertEq(ids(threeTop).slice(0, 3), ['p1*', 'p2*', 'b1'],
      `at most ${MAX_PROMOS_PER_PAGE} promos are pinned even when three are offered`)
    assertEq(threeTop.filter(x => x.promotionId).length, MAX_PROMOS_PER_PAGE,
      `exactly ${MAX_PROMOS_PER_PAGE} promoted entries in total`)

    assertEq(ids(arrangePromoted(base, [{ id: 'B', target_id: 'p1', placement: 'feed_card' }], resolve, getId, 5))[5],
      'p1*', 'a feed_card promo is injected after every 5th item')

    const feedEvery4 = arrangePromoted(
      base, [1, 2, 3].map(n => ({ id: `B${n}`, target_id: `p${n}`, placement: 'feed_card' as const })),
      resolve, getId, 4,
    )
    assertEq(ids(feedEvery4).slice(0, 10), ['b1', 'b2', 'b3', 'b4', 'p1*', 'b5', 'b6', 'b7', 'b8', 'p2*'],
      'feed_card promos interleave every 4 and stop at the cap')
    assertEq(feedEvery4.filter(x => x.promotionId).length, MAX_PROMOS_PER_PAGE,
      'the third feed_card promo is dropped by the cap')

    const dup = arrangePromoted(base, [{ id: 'C', target_id: 'b1', placement: 'top_list' }], resolve, getId, 5)
    assertEq(ids(dup), ['b1*', ...base.slice(1).map(getId)],
      'promoting an item already in the feed shows it once, promoted')
    assertEq(dup.length, base.length, 'and does not lengthen the list')

    assertEq(ids(arrangePromoted(base, [{ id: 'D', target_id: 'missing', placement: 'top_list' }], resolve, getId, 5)),
      base.map(getId), 'an unresolvable target is skipped silently')

    const short = base.slice(0, 3)
    assertEq(ids(arrangePromoted(short, [{ id: 'E', target_id: 'p1', placement: 'feed_card' }], resolve, getId, 5)),
      ['b1', 'b2', 'b3'], 'a list shorter than the inject interval gets no injection')
    assertEq(ids(arrangePromoted([], [{ id: 'F', target_id: 'p1', placement: 'top_list' }], resolve, getId, 5)),
      ['p1*'], 'an empty feed still shows a pinned top_list promo')
  })

  // ── #9 ratings ────────────────────────────────────────────────────────────
  await step('tagsForRating splits positive from negative at 4', () => {
    assertEq(tagsForRating(5), POSITIVE_TAGS, '5 → positive tags')
    assertEq(tagsForRating(4), POSITIVE_TAGS, '4 → positive tags')
    assertEq(tagsForRating(3), NEGATIVE_TAGS, '3 → negative tags')
    assertEq(tagsForRating(1), NEGATIVE_TAGS, '1 → negative tags')
    assert(POSITIVE_TAGS.length > 0 && NEGATIVE_TAGS.length > 0, 'both sets are non-empty')
  })

  await step('sanitizeTags drops anything not in the dictionary', () => {
    assertEq(sanitizeTags(['good_food', 'fast_service']), ['good_food', 'fast_service'], 'known tags survive')
    assertEq(sanitizeTags(['good_food', 'not_a_tag']), ['good_food'], 'an unknown tag is dropped')
    assertEq(sanitizeTags(['good_food', 'good_food']), ['good_food'], 'duplicates are collapsed')
    assertEq(sanitizeTags(['too_slow']), ['too_slow'], 'negative tags are in the dictionary too')
    assertEq(sanitizeTags([]), [], 'an empty array stays empty')
    assertEq(sanitizeTags('good_food'), [], 'a bare string is not an array → empty')
    assertEq(sanitizeTags(null), [], 'null → empty')
    assertEq(sanitizeTags([1, 2, 3]), [], 'non-string entries are dropped')
    assertEq(sanitizeTags([null, 'good_food', undefined]), ['good_food'], 'nullish entries are dropped')
  })

  await step('aggregate', () => {
    const empty = aggregate([])
    assertEq(empty.count, 0, 'no rows → count 0')
    assertEq(empty.average, 0, 'no rows → average 0, not NaN')
    assertEq(empty.top_tags, [], 'no rows → no tags')
    assertEq(empty.distribution, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, 'no rows → an all-zero distribution')

    const rows = [
      { rating: 5, tags: ['good_food', 'fast_service'] },
      { rating: 4, tags: ['good_food'] },
      { rating: 3, tags: null },
    ]
    const agg = aggregate(rows)
    assertEq(agg.count, 3, 'counts every row')
    assertEq(agg.average, 4, '(5+4+3)/3 = 4')
    assertEq(agg.distribution[5], 1, 'one 5-star')
    assertEq(agg.distribution[4], 1, 'one 4-star')
    assertEq(agg.distribution[3], 1, 'one 3-star')
    assertEq(agg.distribution[1], 0, 'no 1-star')
    assertEq(agg.top_tags[0], { id: 'good_food', count: 2 }, 'the most common tag leads')
    assertEq(agg.top_tags[1], { id: 'fast_service', count: 1 }, 'then the next')
    assertEq(agg.top_tags.length, 2, 'a null tags array contributes nothing')

    // 5+4 = 9 / 2 = 4.5 exactly; 5+4+4 = 13/3 = 4.333… → 4.3
    assertEq(aggregate([{ rating: 5, tags: null }, { rating: 4, tags: null }]).average, 4.5,
      'the average keeps one decimal')
    assertEq(aggregate([{ rating: 5, tags: null }, { rating: 4, tags: null }, { rating: 4, tags: null }]).average, 4.3,
      'and rounds to one decimal')

    // Ties break on id ascending, so the ordering is stable across runs.
    const tie = aggregate([{ rating: 5, tags: ['fast_service', 'correct_order'] }])
    assertEq(tie.top_tags.map(t => t.id), ['correct_order', 'fast_service'], 'equal counts sort by id')

    assertEq(aggregate([{ rating: 9, tags: null }]).distribution[5], 0,
      'an out-of-range rating lands in no bucket')
    assertEq(aggregate(Array.from({ length: 9 }, (_, i) => ({ rating: 5, tags: [`t${i}`] }))).top_tags.length, 5,
      'top_tags is capped at 5')
  })

  // ── #13 broadcast ─────────────────────────────────────────────────────────
  await step('computeBroadcastCost respects the minimum charge', () => {
    const pricing = { price_per_recipient: 50, min_charge: 1000, max_message_length: 1000 }
    assertEq(computeBroadcastCost(0, pricing), 1000, 'zero recipients still costs the minimum')
    assertEq(computeBroadcastCost(10, pricing), 1000, '10 × 50 = 500, below the minimum → minimum')
    assertEq(computeBroadcastCost(20, pricing), 1000, '20 × 50 = 1000, exactly the minimum')
    assertEq(computeBroadcastCost(21, pricing), 1050, '21 × 50 = 1050, above the minimum → per-recipient')
    assertEq(computeBroadcastCost(100, pricing), 5000, '100 recipients priced per head')
    assertEq(computeBroadcastCost(100, { ...pricing, price_per_recipient: 0 }), 1000,
      'free per head still charges the minimum')
  })

  await step('formatBroadcastMessage', () => {
    const restaurant = {
      title: 'Promo', message: 'Ndolé à 2000 FCFA', sender_name: 'Chez Manu',
      restaurant_name: 'Chez Manu', sender_type: 'restaurant' as const,
    }
    const fr = formatBroadcastMessage(restaurant, 'fr')
    assertIncludes(fr, 'Message de Chez Manu', 'the FR header names the sender')
    assertIncludes(fr, '🏪 Chez Manu', 'a restaurant sender gets the shop line')
    assertIncludes(fr, '*Promo*', 'the title is bolded')
    assertIncludes(fr, 'Ndolé à 2000 FCFA', 'the body is passed through verbatim')
    assertIncludes(fr, 'desabonner', 'the FR footer carries the unsubscribe keyword')

    const en = formatBroadcastMessage(restaurant, 'en')
    assertIncludes(en, 'Message from Chez Manu', 'the EN header is localised')
    assertIncludes(en, 'unsubscribe', 'the EN footer carries the EN keyword')
    assertIncludes(en, 'Ndolé à 2000 FCFA', 'the body is NOT translated')

    const publisher = formatBroadcastMessage({
      title: 'Concert', message: 'Samedi', sender_name: 'Ada', organization: 'Ada Events',
      sender_type: 'publisher' as const,
    }, 'fr')
    assertIncludes(publisher, '🎉 Ada Events', 'a publisher sender gets the organisation line')
    assert(!publisher.includes('🏪'), 'and not the restaurant line')

    const noTitle = formatBroadcastMessage({
      title: '', message: 'Juste le corps', sender_name: 'Ada', sender_type: 'publisher' as const,
    }, 'fr')
    assertIncludes(noTitle, 'Juste le corps', 'an empty title still sends the body')
    assert(!noTitle.includes('**'), 'and renders no empty bold block')

    assertEq(formatBroadcastMessage(restaurant), formatBroadcastMessage(restaurant, 'fr'), 'lang defaults to fr')
  })

  // ── #14 rate limit ────────────────────────────────────────────────────────
  await step('rateLimit — Nth call inside the window is refused, then the window resets', async () => {
    // Unique keys per assertion: the bucket map is module-global and shared
    // with anything else importing lib/rateLimit in this process.
    const key = `testkit-${Date.now()}-a`
    assertEq(rateLimit({ key, max: 3, windowMs: 60_000 }), null, '1st call allowed')
    assertEq(rateLimit({ key, max: 3, windowMs: 60_000 }), null, '2nd call allowed')
    assertEq(rateLimit({ key, max: 3, windowMs: 60_000 }), null, '3rd call allowed (max)')

    const blocked = rateLimit({ key, max: 3, windowMs: 60_000 })
    assert(blocked !== null, '4th call is refused')
    assert((blocked?.retryAfterSec ?? 0) > 0, 'the refusal carries a positive retry-after')
    assertIncludes(blocked?.message, 'trop de requêtes', 'the FR half of the message')
    assertIncludes(blocked?.message, 'too many requests', 'the EN half of the message')

    const other = `testkit-${Date.now()}-b`
    assertEq(rateLimit({ key: other, max: 1, windowMs: 60_000 }), null,
      'a different key has its own independent budget')

    // Real (short) window rather than a mocked clock — lib/rateLimit reads
    // Date.now() directly and takes no injectable clock.
    const shortKey = `testkit-${Date.now()}-c`
    assertEq(rateLimit({ key: shortKey, max: 1, windowMs: 80 }), null, 'short-window 1st call allowed')
    assert(rateLimit({ key: shortKey, max: 1, windowMs: 80 }) !== null, 'short-window 2nd call refused')
    await sleep(140)
    assertEq(rateLimit({ key: shortKey, max: 1, windowMs: 80 }), null, 'allowed again once the window has slid past')
  })

  // ── #15 reservation codes ─────────────────────────────────────────────────
  await step('randomReservationCode', () => {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    assertEq(randomReservationCode().length, 4, 'defaults to 4 characters')
    assertEq(randomReservationCode(6).length, 6, 'honours an explicit length')
    assertEq(randomReservationCode(0).length, 0, 'a zero length yields an empty code')

    const codes = Array.from({ length: 500 }, () => randomReservationCode())
    assert(codes.every(c => c.length === 4), 'every sample is 4 characters')
    assert(codes.every(c => c.split('').every(ch => ALPHABET.includes(ch))), 'every character is in the alphabet')

    const joined = codes.join('')
    for (const bad of ['0', 'O', '1', 'I']) {
      assert(!joined.includes(bad), `the ambiguous glyph "${bad}" never appears`)
    }

    // 32^4 ≈ 1M, so 500 draws colliding heavily would mean a broken RNG.
    // This is a smoke check on entropy, not a uniqueness guarantee — real
    // uniqueness comes from generateReservationCode()'s DB pre-check.
    assert(new Set(codes).size > 450, '500 draws produce mostly distinct codes')
  })

  finish(SUITE)
}

void main()
