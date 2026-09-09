// TEST-PLAN.md §1c #38 ratings, #39 subscriptions (HTTP half),
// #40 promotions and #41 reports. The complete social surface.
//
// The WhatsApp half of #39 — "mes abonnements" and "desabonner" — is already
// covered in api-whatsapp-router.ts. This file covers the HTTP routes.
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │ RATINGS ARE PER-ORDER BY DESIGN. DO NOT "FIX" THIS INTO PER-RESTAURANT │
// │ WITHOUT A PRODUCT DECISION.                                           │
// │                                                                       │
// │ The UNIQUE key is (restaurant_id, customer_id, ORDER_ID), not          │
// │ (restaurant_id, customer_id). One customer with two delivered orders   │
// │ at the same restaurant legitimately leaves TWO ratings, and BOTH count │
// │ toward the public average. Re-rating the SAME order updates in place.  │
// │                                                                       │
// │ Every rating is anchored to a real delivered or completed order, which │
// │ is a stronger integrity bar than most platforms — but it does mean a   │
// │ customer's influence on the average scales with how often they order.  │
// │ That is a KNOWN, ACCEPTED TRADEOFF, parked for post-launch review: the │
// │ exploit costs real money per vote and /rate is capped at 5 per hour.   │
// │                                                                       │
// │ The assertions below pin the per-order behaviour deliberately. If a    │
// │ future change makes them fail, that is a product decision to make      │
// │ on purpose, not a test to update.                                     │
// └───────────────────────────────────────────────────────────────────────┘
//
// 🔴 RATE LIMIT. /rate is capped at 5 writes per SESSION per hour
// (rate/route.ts:26), keyed on session.id — a detail easy to miss because it
// is not on the restaurant. A limited call returns 429, which is at least
// distinguishable from a refusal, but it would still silently starve later
// assertions. So every case gets its OWN fresh customer, and the one case
// where the limit IS the subject sends 5 from a single identity and asserts
// the 6th is refused.
//
// SAFETY: no subscriber fan-out anywhere in these routes — subscribe,
// unsubscribe and rate send nothing at all. Confirmed by grep, not assumed.
// Subscriptions do briefly make a test customer a real subscriber for a real
// city, which is harmless: the phone is +999, and no suite publishes an event
// in a real city (api-events uses a run-namespaced one).

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, type TestCustomer } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { SUBSCRIPTION_CITIES } from '@/lib/subscriptions'
import { adminCookie } from '../testkit/session'

const SUITE = 'api-social'

interface RateBody { ok?: boolean; rating_id?: string; updated?: boolean; error?: string }
interface AggBody {
  average?: number; count?: number
  distribution?: Record<string, number>
  top_tags?: Array<{ id: string; count: number }>
  can_rate?: boolean
  their_rating?: { rating: number; tags: string[]; order_id: string } | null
}
interface SubsBody {
  ok?: boolean; id?: string; count?: number; error?: string
  subscriptions?: Array<{ id: string; city: string; categories: string[] | null; is_active: boolean; unsubscribed_at: string | null }>
}

async function main(): Promise<void> {
  try {
    // A single restaurant to rate. Its owner never rates it.
    const owner = await makeCustomer({ suiteNo: 38, name: 'Social Owner' })
    const rest  = await makeRestaurant({ ownerId: owner.id, label: 'social_rest', whatsapp: owner.phone })

    const rate = (restaurantId: string, body: Record<string, unknown>, cookie: string | null) =>
      api<RateBody>(`/api/restaurants/${restaurantId}/rate`, {
        method: 'POST', body, ...(cookie ? { cookie } : {}),
      })
    const aggregateFor = (restaurantId: string, cookie?: string | null) =>
      api<AggBody>(`/api/restaurants/${restaurantId}/rating`, { ...(cookie ? { cookie } : {}) })

    const ratingRows = async (restaurantId: string) => {
      const { data } = await sb.from('restaurant_ratings')
        .select('id, rating, tags, customer_id, order_id').eq('restaurant_id', restaurantId)
      return (data ?? []) as Array<{ id: string; rating: number; tags: string[] | null; customer_id: string; order_id: string }>
    }
    // Ratings are created through the API, so the ledger has not seen them.
    const trackRating = (b: RateBody): string => {
      const id = b.rating_id ?? ''
      if (id) track('restaurant_ratings', id)
      return id
    }

    // Each rating case gets a fresh buyer so the 5/hour cap never starves it.
    const newBuyer = async (label: string, orders = 1): Promise<{ c: TestCustomer; cookie: string; orderIds: string[] }> => {
      const c = await makeCustomer({ suiteNo: 38, name: label })
      const orderIds: string[] = []
      for (let i = 0; i < orders; i++) {
        const o = await makeOrder(rest.id, c, { status: 'delivered' })
        orderIds.push(o.id)
      }
      return { c, cookie: customerCookie(c), orderIds }
    }

    // ══ #38 RATINGS ════════════════════════════════════════════════════════

    await step('#38 a verified buyer can rate, with tags', async () => {
      const { c, cookie } = await newBuyer('Rater One')
      const r = await rate(rest.id, { rating: 5, tags: ['good_food', 'fast_service'] }, cookie)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.ok, true, 'ok=true')
      assertEq(r.body.updated, false, 'updated=false — this is a new rating')
      const id = trackRating(r.body)
      assert(!!id, 'a rating_id came back')

      const rows = (await ratingRows(rest.id)).filter(x => x.customer_id === c.id)
      assertEq(rows.length, 1, 'exactly one row for this customer')
      assertEq(rows[0]?.rating, 5, 'the rating persisted')
      assertEq(rows[0]?.tags, ['good_food', 'fast_service'], 'and the tags')
    })

    await step('#38 unknown tags are dropped, not rejected', async () => {
      const { c, cookie } = await newBuyer('Rater Tags')
      const r = await rate(rest.id, { rating: 4, tags: ['good_food', 'not_a_real_tag', 'good_food'] }, cookie)
      assertEq(r.status, 200, 'HTTP 200 — a stale tag does not fail the submission')
      trackRating(r.body)
      const rows = (await ratingRows(rest.id)).filter(x => x.customer_id === c.id)
      assertEq(rows[0]?.tags, ['good_food'], 'the unknown tag is dropped and the duplicate collapsed')
    })

    await step('#38 re-rating the SAME order updates in place', async () => {
      const { c, cookie, orderIds } = await newBuyer('Rater Update')
      const first = await rate(rest.id, { rating: 2, tags: ['too_slow'], orderId: orderIds[0] }, cookie)
      assertEq(first.body.updated, false, 'the first submission creates')
      const firstId = trackRating(first.body)

      const second = await rate(rest.id, { rating: 5, tags: ['good_food'], orderId: orderIds[0] }, cookie)
      assertEq(second.status, 200, 'HTTP 200')
      assertEq(second.body.updated, true, 'updated=true — the second submission REPLACES')
      assertEq(second.body.rating_id, firstId, 'and it is the same row, not a new one')

      const rows = (await ratingRows(rest.id)).filter(x => x.customer_id === c.id)
      assertEq(rows.length, 1, 'still exactly ONE row for this customer+order')
      assertEq(rows[0]?.rating, 5, 'carrying the new score')
      assertEq(rows[0]?.tags, ['good_food'], 'and the new tags')
    })

    await step('#38 two DIFFERENT delivered orders produce two ratings — per-order by design', async () => {
      // See the header box. This is the accepted tradeoff, pinned on purpose:
      // the key is (restaurant, customer, ORDER), so a repeat customer rates
      // each order and both count. Failing here is a product decision, not a
      // test to update.
      const { c, cookie, orderIds } = await newBuyer('Rater Twice', 2)
      const a = await rate(rest.id, { rating: 5, orderId: orderIds[0] }, cookie)
      const b = await rate(rest.id, { rating: 1, orderId: orderIds[1] }, cookie)
      assertEq(a.body.updated, false, 'the first order creates a rating')
      assertEq(b.body.updated, false, 'the second order creates ANOTHER rating, not an update')
      assert(a.body.rating_id !== b.body.rating_id, 'they are distinct rows')
      trackRating(a.body); trackRating(b.body)

      const rows = (await ratingRows(rest.id)).filter(x => x.customer_id === c.id)
      assertEq(rows.length, 2, 'two rows for ONE customer at ONE restaurant')
      assertEq(new Set(rows.map(x => x.order_id)).size, 2, 'one per order')
    })

    await step('#38 a NON-buyer cannot rate', async () => {
      const stranger = await makeCustomer({ suiteNo: 38, name: 'Never Ordered' })
      const cookie = customerCookie(stranger)
      const before = (await ratingRows(rest.id)).length

      const r = await rate(rest.id, { rating: 5 }, cookie)
      assertEq(r.status, 403, 'HTTP 403')
      assert((r.body.error ?? '').toLowerCase().includes('commandez'),
        'the error tells them to order first')
      assertEq((await ratingRows(rest.id)).length, before, 'and no rating row was created')
    })

    await step('#38 an order that is not yet delivered cannot be rated', async () => {
      const c = await makeCustomer({ suiteNo: 38, name: 'Pending Buyer' })
      const cookie = customerCookie(c)
      const pending = await makeOrder(rest.id, c, { status: 'pending' })
      const before = (await ratingRows(rest.id)).length

      const explicit = await rate(rest.id, { rating: 5, orderId: pending.id }, cookie)
      assertEq(explicit.status, 409, 'an explicit undelivered orderId → 409')

      // Without an orderId the route finds no delivered order at all.
      const implicit = await rate(rest.id, { rating: 5 }, cookie)
      assertEq(implicit.status, 403, 'and with no orderId → 403, nothing to anchor to')
      assertEq((await ratingRows(rest.id)).length, before, 'no row either way')
    })

    await step("#38 another customer's order cannot be used as an anchor", async () => {
      const mine   = await newBuyer('Anchor Mine')
      const theirs = await newBuyer('Anchor Theirs')
      const before = (await ratingRows(rest.id)).length

      const r = await rate(rest.id, { rating: 5, orderId: theirs.orderIds[0] }, mine.cookie)
      assertEq(r.status, 403, "borrowing someone else's order → 403")

      const unknown = await rate(rest.id, { rating: 5, orderId: '00000000-0000-0000-0000-000000000000' }, mine.cookie)
      assertEq(unknown.status, 404, 'an unknown orderId → 404')

      // An order at a DIFFERENT restaurant is also refused.
      const otherRest = await makeRestaurant({ label: 'social_other' })
      const elsewhere = await makeOrder(otherRest.id, mine.c, { status: 'delivered' })
      const wrongRest = await rate(rest.id, { rating: 5, orderId: elsewhere.id }, mine.cookie)
      assertEq(wrongRest.status, 403, "an order from another restaurant → 403")

      assertEq((await ratingRows(rest.id)).length, before, 'none of the three created a row')
    })

    await step('#38 rating validation and auth', async () => {
      const { cookie } = await newBuyer('Rater Validation')
      const before = (await ratingRows(rest.id)).length

      for (const bad of [0, 6, -1, 'five', null]) {
        const r = await rate(rest.id, { rating: bad }, cookie)
        assertEq(r.status, 400, `rating=${JSON.stringify(bad)} → 400`)
      }
      assertEq((await rate(rest.id, { rating: 5 }, null)).status, 401, 'no session → 401')
      assertEq((await ratingRows(rest.id)).length, before, 'no rejected call created a row')
    })

    await step('#38 the aggregate computes average, distribution and tag histogram', async () => {
      // Its own restaurant so the numbers are exact rather than order-dependent.
      const solo = await makeRestaurant({ label: 'social_agg' })
      const scores: Array<[number, string[]]> = [
        [5, ['good_food', 'fast_service']],
        [5, ['good_food']],
        [2, ['too_slow']],
      ]
      for (let i = 0; i < scores.length; i++) {
        const b = await makeCustomer({ suiteNo: 38, name: `Agg Rater ${i}` })
        const o = await makeOrder(solo.id, b, { status: 'delivered' })
        const r = await rate(solo.id, { rating: scores[i][0], tags: scores[i][1], orderId: o.id }, customerCookie(b))
        assertEq(r.status, 200, `rating ${i + 1} accepted`)
        trackRating(r.body)
      }

      const agg = await aggregateFor(solo.id)
      assertEq(agg.status, 200, 'HTTP 200')
      assertEq(agg.body.count, 3, 'counts every rating')
      assertEq(agg.body.average, 4, '(5+5+2)/3 = 4')
      assertEq(agg.body.distribution?.['5'], 2, 'two 5-star')
      assertEq(agg.body.distribution?.['2'], 1, 'one 2-star')
      assertEq(agg.body.distribution?.['3'], 0, 'no 3-star')
      assertEq(agg.body.top_tags?.[0], { id: 'good_food', count: 2 }, 'the most common tag leads')
      assert((agg.body.top_tags ?? []).some(t => t.id === 'too_slow'), 'and a negative tag is counted too')

      // The bulk endpoint agrees with the per-restaurant one.
      const summary = await api<{ summary?: Record<string, { average: number; count: number }> }>(
        `/api/restaurants/ratings-summary?ids=${solo.id}`,
      )
      assertEq(summary.status, 200, 'ratings-summary HTTP 200')
      assertEq(summary.body.summary?.[solo.id]?.average, 4, 'same average')
      assertEq(summary.body.summary?.[solo.id]?.count, 3, 'same count')

      // A restaurant with no ratings is ABSENT rather than zeroed.
      const empty = await makeRestaurant({ label: 'social_norate' })
      const s2 = await api<{ summary?: Record<string, unknown> }>(
        `/api/restaurants/ratings-summary?ids=${empty.id}`,
      )
      assertEq(s2.body.summary?.[empty.id], undefined,
        'an unrated restaurant is omitted from the summary, not returned as 0')
    })

    await step('#38 the aggregate is public; can_rate / their_rating need a session', async () => {
      const solo = await makeRestaurant({ label: 'social_canrate' })
      const b = await makeCustomer({ suiteNo: 38, name: 'CanRate Buyer' })
      const o = await makeOrder(solo.id, b, { status: 'delivered' })
      const cookie = customerCookie(b)

      const anon = await aggregateFor(solo.id)
      assertEq(anon.status, 200, 'anonymous can read the aggregate')
      assertEq(anon.body.can_rate, false, 'but can_rate is false with no session')
      assertEq(anon.body.their_rating, null, 'and their_rating is null')

      const before = await aggregateFor(solo.id, cookie)
      assertEq(before.body.can_rate, true, 'a buyer with a delivered order can rate')
      assertEq(before.body.their_rating, null, 'and has no rating yet')

      const r = await rate(solo.id, { rating: 4, tags: ['good_value'], orderId: o.id }, cookie)
      trackRating(r.body)

      const after = await aggregateFor(solo.id, cookie)
      assertEq(after.body.their_rating?.rating, 4, 'after rating, their_rating is returned for pre-fill')
      assertEq(after.body.their_rating?.order_id, o.id, 'anchored to their order')

      const stranger = await makeCustomer({ suiteNo: 38, name: 'CanRate Stranger' })
      const none = await aggregateFor(solo.id, customerCookie(stranger))
      assertEq(none.body.can_rate, false, 'a non-buyer cannot rate')
      assertEq(none.body.count, 1, 'though they still see the public count')
    })

    await step('#38 the 5-per-hour cap is enforced on the 6th write', async () => {
      // The one case where the limit IS the subject: five orders, one buyer,
      // five accepted writes, then the sixth refused. Everything else in this
      // suite uses a fresh identity so no incidental limit can mask a gate.
      const solo = await makeRestaurant({ label: 'social_ratelimit' })
      const b = await makeCustomer({ suiteNo: 38, name: 'Rate Limit Buyer' })
      const cookie = customerCookie(b)
      const orders: string[] = []
      for (let i = 0; i < 6; i++) {
        orders.push((await makeOrder(solo.id, b, { status: 'delivered' })).id)
      }

      for (let i = 0; i < 5; i++) {
        const r = await rate(solo.id, { rating: 5, orderId: orders[i] }, cookie)
        assertEq(r.status, 200, `write ${i + 1} of 5 accepted`)
        trackRating(r.body)
      }

      const sixth = await rate(solo.id, { rating: 5, orderId: orders[5] }, cookie)
      assertEq(sixth.status, 429, 'the 6th write in the window → 429')
      assertEq((await ratingRows(solo.id)).length, 5, 'and it created no row')

      // A DIFFERENT customer is unaffected — the limit is per session, not
      // per restaurant.
      const fresh = await makeCustomer({ suiteNo: 38, name: 'Unaffected Buyer' })
      const fo = await makeOrder(solo.id, fresh, { status: 'delivered' })
      const ok = await rate(solo.id, { rating: 3, orderId: fo.id }, customerCookie(fresh))
      assertEq(ok.status, 200, 'another customer can still rate — the cap is per session')
      trackRating(ok.body)
    })

    // ══ #39 SUBSCRIPTIONS (HTTP half) ══════════════════════════════════════

    const subscribe = (body: Record<string, unknown>, cookie: string | null) =>
      api<SubsBody>('/api/subscriptions/subscribe', { method: 'POST', body, ...(cookie ? { cookie } : {}) })
    const mySubs = (cookie: string | null) =>
      api<SubsBody>('/api/subscriptions/my', { ...(cookie ? { cookie } : {}) })
    const unsubscribe = (body: Record<string, unknown>, cookie: string | null) =>
      api<SubsBody>('/api/subscriptions/unsubscribe', { method: 'POST', body, ...(cookie ? { cookie } : {}) })

    const storedSubs = async (customerId: string) => {
      const { data } = await sb.from('event_subscriptions')
        .select('id, city, categories, is_active, unsubscribed_at').eq('customer_id', customerId)
      return (data ?? []) as Array<{ id: string; city: string; categories: string[] | null; is_active: boolean; unsubscribed_at: string | null }>
    }
    // event_subscriptions has no phone or name column, so the pattern sweeper
    // cannot see it. deleteCascades now clears it from the tracked customer,
    // and these ids are tracked as well — belt and braces.
    const trackSub = (b: SubsBody): string => {
      const id = b.id ?? ''
      if (id) track('event_subscriptions', id)
      return id
    }

    const CITY_A = SUBSCRIPTION_CITIES[0]
    const CITY_B = SUBSCRIPTION_CITIES[1]

    await step('#39 subscribe by city, with and without a category filter', async () => {
      const c = await makeCustomer({ suiteNo: 39, name: 'Subscriber One' })
      const cookie = customerCookie(c)

      const all = await subscribe({ city: CITY_A }, cookie)
      assertEq(all.status, 200, `HTTP 200 (body ${all.raw.slice(0, 160)})`)
      trackSub(all.body)
      let rows = await storedSubs(c.id)
      assertEq(rows.length, 1, 'one subscription row')
      assertEq(rows[0]?.city, CITY_A, 'for the requested city')
      assertEq(rows[0]?.categories, null, 'categories null = every category')
      assertEq(rows[0]?.is_active, true, 'and active')

      const filtered = await subscribe({ city: CITY_B, categories: ['Concert', 'Festival'] }, cookie)
      assertEq(filtered.status, 200, 'a second city with a filter → 200')
      trackSub(filtered.body)
      rows = await storedSubs(c.id)
      assertEq(rows.length, 2, 'two subscriptions, one per city')
      const bRow = rows.find(x => x.city === CITY_B)
      assertEq(bRow?.categories, ['Concert', 'Festival'], 'the whitelist is stored')
    })

    await step('#39 subscribe is idempotent per city — it upserts', async () => {
      const c = await makeCustomer({ suiteNo: 39, name: 'Subscriber Idem' })
      const cookie = customerCookie(c)

      const first = await subscribe({ city: CITY_A, categories: ['Concert'] }, cookie)
      trackSub(first.body)
      const second = await subscribe({ city: CITY_A, categories: ['Sport'] }, cookie)
      assertEq(second.status, 200, 'a repeat subscribe is accepted')
      trackSub(second.body)

      const rows = await storedSubs(c.id)
      assertEq(rows.length, 1, 'still ONE row for that city — not a duplicate')
      assertEq(rows[0]?.categories, ['Sport'], 'the categories were overwritten')
    })

    await step('#39 an unknown category list is filtered; an unknown city is refused', async () => {
      const c = await makeCustomer({ suiteNo: 39, name: 'Subscriber Filter' })
      const cookie = customerCookie(c)

      const r = await subscribe({ city: CITY_A, categories: ['Concert', 'NotACategory'] }, cookie)
      assertEq(r.status, 200, 'an unknown category does not fail the request')
      trackSub(r.body)
      assertEq((await storedSubs(c.id))[0]?.categories, ['Concert'], 'it is filtered out')

      assertEq((await subscribe({ city: 'Nowhere' }, cookie)).status, 400, 'a city outside the list → 400')
      assertEq((await subscribe({}, cookie)).status, 400, 'a missing city → 400')
      assertEq((await storedSubs(c.id)).length, 1, 'and neither created a row')
    })

    await step('#39 /my lists the caller’s own subscriptions only', async () => {
      const mine   = await makeCustomer({ suiteNo: 39, name: 'Subs Mine' })
      const theirs = await makeCustomer({ suiteNo: 39, name: 'Subs Theirs' })
      trackSub((await subscribe({ city: CITY_A }, customerCookie(mine))).body)
      trackSub((await subscribe({ city: CITY_B }, customerCookie(theirs))).body)

      const r = await mySubs(customerCookie(mine))
      assertEq(r.status, 200, 'HTTP 200')
      const cities = (r.body.subscriptions ?? []).map(s => s.city)
      assert(cities.includes(CITY_A), 'their own subscription is listed')
      assert(!cities.includes(CITY_B), "and not the other customer's")

      const anon = await mySubs(null)
      assertEq(anon.status, 200, 'anonymous gets 200, not 401')
      assertEq(anon.body.subscriptions, [], 'with an empty list — callers need not special-case')
    })

    await step('#39 unsubscribe DEACTIVATES; the row survives', async () => {
      const c = await makeCustomer({ suiteNo: 39, name: 'Unsub One City' })
      const cookie = customerCookie(c)
      trackSub((await subscribe({ city: CITY_A }, cookie)).body)
      trackSub((await subscribe({ city: CITY_B }, cookie)).body)

      const r = await unsubscribe({ city: CITY_A }, cookie)
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.count, 1, 'it reports one row deactivated')

      const rows = await storedSubs(c.id)
      assertEq(rows.length, 2, 'BOTH rows still exist — this is a soft disable')
      const a = rows.find(x => x.city === CITY_A)
      const b = rows.find(x => x.city === CITY_B)
      assertEq(a?.is_active, false, 'the named city is deactivated')
      assert(!!a?.unsubscribed_at, 'and stamped with unsubscribed_at')
      assertEq(b?.is_active, true, 'the other city is untouched')

      // Repeat is a no-op rather than an error.
      const again = await unsubscribe({ city: CITY_A }, cookie)
      assertEq(again.status, 200, 'unsubscribing twice is accepted')
      assertEq(again.body.count, 0, 'and reports zero rows changed')
    })

    await step('#39 unsubscribe with no city deactivates everything', async () => {
      const c = await makeCustomer({ suiteNo: 39, name: 'Unsub All' })
      const cookie = customerCookie(c)
      trackSub((await subscribe({ city: CITY_A }, cookie)).body)
      trackSub((await subscribe({ city: CITY_B }, cookie)).body)

      const r = await unsubscribe({}, cookie)
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.count, 2, 'both rows deactivated')
      const rows = await storedSubs(c.id)
      assertEq(rows.length, 2, 'both rows still exist')
      assert(rows.every(x => !x.is_active), 'and neither is active')

      assertEq((await unsubscribe({}, null)).status, 401, 'anonymous unsubscribe → 401')
    })

    await step('#39 the audience query reflects subscribe and unsubscribe', async () => {
      // countMatchingSubscribers is what the event fan-out consults, so this
      // is the assertion that actually matters for who gets messaged.
      const { countMatchingSubscribers } = await import('@/lib/subscriptions')
      const c = await makeCustomer({ suiteNo: 39, name: 'Audience Member' })
      const cookie = customerCookie(c)

      // Each category needs its OWN baseline: an existing subscriber with a
      // null category list matches EVERY category, so the Concert and Sport
      // counts are not interchangeable.
      const concertBefore = await countMatchingSubscribers({ city: CITY_A, category: 'Concert' })
      const sportBefore   = await countMatchingSubscribers({ city: CITY_A, category: 'Sport' })

      trackSub((await subscribe({ city: CITY_A, categories: ['Concert'] }, cookie)).body)

      const concertAfter = await countMatchingSubscribers({ city: CITY_A, category: 'Concert' })
      assertEq(concertAfter, concertBefore + 1, 'subscribing adds the customer to that audience')

      const sportAfter = await countMatchingSubscribers({ city: CITY_A, category: 'Sport' })
      assertEq(sportAfter, sportBefore, 'but NOT to a category outside their whitelist')

      await unsubscribe({ city: CITY_A }, cookie)
      const afterUnsub = await countMatchingSubscribers({ city: CITY_A, category: 'Concert' })
      assertEq(afterUnsub, concertBefore, 'unsubscribing removes them from the audience again')
    })

    await step('#39 subscribe requires a session', async () => {
      assertEq((await subscribe({ city: CITY_A }, null)).status, 401, 'no session → 401')
    })
    // ══ #40 PROMOTIONS ═════════════════════════════════════════════════════
    //
    // 🔴 POST /api/promotions IS NEVER CALLED FOR A SUCCESSFUL CREATE, AND
    // MUST NOT BE. It initiates a real PawaPay Mobile Money deposit
    // (promotions/route.ts:107 createDeposit) — a third-party system with no
    // delete API, so a "successful" create would leave PERMANENT residue that
    // test-sweep.ts can never reach. TEST-PLAN §3 excludes PawaPay initiate
    // for exactly this reason. It is also why the row is created as 'draft':
    // it only becomes 'pending_review' on the payment webhook
    // (payments/webhook/route.ts:212), which is plan item #43, not this one.
    //
    // So the moderation lifecycle is tested from rows SEEDED at
    // pending_review, and the real endpoint is driven ONLY for inputs that
    // fail BEFORE createDeposit is reached — validation and eligibility.
    //
    // ┌─────────────────────────────────────────────────────────────────────┐
    // │ ELIGIBILITY: asPublisher IS COMPUTED AND NEVER USED.                │
    // │ getPromotionEligibility (lib/promotions.ts) works out whether the   │
    // │ caller is a "verified publisher" (auto-approve, or >=1 approved     │
    // │ event) and returns it — but neither the route nor the create guard  │
    // │ reads it. The events list is returned unfiltered, so ANY organizer  │
    // │ with an active event can promote it, verified or not, contrary to   │
    // │ the doc comment.                                                     │
    // │                                                                     │
    // │ Not a security hole — you still cannot promote someone ELSE's event │
    // │ — so it is pinned as-is rather than changed reactively. The dead    │
    // │ asPublisher computation is a minor cleanup item, filed not fixed.   │
    // └─────────────────────────────────────────────────────────────────────┘

    interface PromoRow {
      id: string; status: string; payment_status: string; impressions: number | null
      clicks: number | null; promoter_id: string; city: string; target_type: string
    }
    interface PromoApiBody { ok?: boolean; error?: string; throttled?: boolean; promotions?: Array<{ id: string }> }

    const promoRow = async (id: string): Promise<PromoRow | null> => {
      const { data } = await sb.from('promotions')
        .select('id, status, payment_status, impressions, clicks, promoter_id, city, target_type')
        .eq('id', id).maybeSingle()
      return data as PromoRow | null
    }

    // Seeded directly — see the note above. Never through the API.
    const seedPromo = async (opts: {
      promoterId: string; targetType: 'restaurant' | 'event'; targetId: string
      city: string; status?: string; paymentStatus?: string
    }): Promise<string> => {
      const today = new Date()
      const start = new Date(today.getTime() - 86400_000).toISOString().slice(0, 10)
      const end   = new Date(today.getTime() + 7 * 86400_000).toISOString().slice(0, 10)
      const { data, error } = await sb.from('promotions').insert({
        promoter_id:    opts.promoterId,
        target_type:    opts.targetType,
        target_id:      opts.targetId,
        placement:      'feed_card',
        city:           opts.city,
        start_date:     start,
        end_date:       end,
        total_budget:   1000,
        payment_status: opts.paymentStatus ?? 'paid',
        status:         opts.status ?? 'pending_review',
        impressions:    0,
        clicks:         0,
      } as never).select('id').single()
      if (error) throw new Error(`seedPromo failed: ${error.message}`)
      const id = (data as unknown as { id: string }).id
      track('promotions', id)
      return id
    }

    const approvePromo = (id: string, cookie: string | null) =>
      api<PromoApiBody>(`/api/admin/promotions/${id}/approve`, { method: 'POST', ...(cookie ? { cookie } : {}) })
    const rejectPromo = (id: string, body: Record<string, unknown>, cookie: string | null) =>
      api<PromoApiBody>(`/api/admin/promotions/${id}/reject`, { method: 'POST', body, ...(cookie ? { cookie } : {}) })

    const admin = await adminCookie()
    const promoter = await makeCustomer({ suiteNo: 40, name: 'Promoter' })
    const promoRest = await makeRestaurant({ ownerId: promoter.id, label: 'promo_rest', whatsapp: promoter.phone })
    const promoCity = 'Yaoundé'

    await step('#40 admin approve flips pending_review → active', async () => {
      const id = await seedPromo({ promoterId: promoter.id, targetType: 'restaurant', targetId: promoRest.id, city: promoCity })
      assertEq((await promoRow(id))?.status, 'pending_review', 'seeded awaiting review')

      const r = await approvePromo(id, admin)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq((await promoRow(id))?.status, 'active', "status='active'")

      // Re-approving an already-active promo is refused by the status guard.
      const again = await approvePromo(id, admin)
      assertEq(again.status, 400, 'approving a non-pending promo → 400')
      assertEq((await promoRow(id))?.status, 'active', 'and it stays active')

      const { data } = await sb.from('audit_log').select('action')
        .eq('target_id', id).eq('action', 'promotion_approved').maybeSingle()
      assert(!!data, 'an approval audit row was written')
    })

    await step('#40 admin reject flips it to rejected and records the reason', async () => {
      const id = await seedPromo({ promoterId: promoter.id, targetType: 'restaurant', targetId: promoRest.id, city: promoCity })
      const r = await rejectPromo(id, { reason: 'Not suitable' }, admin)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)

      const { data } = await sb.from('promotions')
        .select('status, rejection_reason').eq('id', id).maybeSingle()
      assertEq((data as { status?: string } | null)?.status, 'rejected', "status='rejected'")
      assertEq((data as { rejection_reason?: string } | null)?.rejection_reason, 'Not suitable',
        'the reason is stored')
      // The promoter gets a WhatsApp — to our +999 fixture, so it fails
      // harmlessly. Asserted on the row, never on delivery.
    })

    await step('#40 approve and reject are admin-only', async () => {
      const id = await seedPromo({ promoterId: promoter.id, targetType: 'restaurant', targetId: promoRest.id, city: promoCity })
      const strangerCookie = customerCookie(await makeCustomer({ suiteNo: 40, name: 'Promo Stranger' }))
      const promoterCookie = customerCookie(promoter)

      for (const [label, cookie] of [
        ['a stranger', strangerCookie],
        ['the promoter themselves', promoterCookie],
        ['anonymous', null],
      ] as const) {
        assertEq((await approvePromo(id, cookie)).status, 401, `${label} cannot approve → 401`)
        assertEq((await rejectPromo(id, { reason: 'x' }, cookie)).status, 401, `${label} cannot reject → 401`)
      }
      assertEq((await promoRow(id))?.status, 'pending_review',
        'the promotion is untouched after every refusal')
    })

    await step('#40 /active returns an active promo and hides it from its own promoter', async () => {
      const id = await seedPromo({ promoterId: promoter.id, targetType: 'restaurant', targetId: promoRest.id, city: promoCity })
      await approvePromo(id, admin)

      const anon = await api<PromoApiBody>(`/api/promotions/active?city=${encodeURIComponent(promoCity)}&type=restaurant`)
      assertEq(anon.status, 200, 'HTTP 200')
      assert((anon.body.promotions ?? []).some(p => p.id === id), 'the active promo is returned')

      // The promoter is filtered out so they cannot inflate their own
      // impressions while scrolling the feed.
      const own = await api<PromoApiBody>(
        `/api/promotions/active?city=${encodeURIComponent(promoCity)}&type=restaurant`,
        { cookie: customerCookie(promoter) })
      assert(!(own.body.promotions ?? []).some(p => p.id === id),
        'but NOT to the promoter themselves')

      // A pending promo never appears.
      const pending = await seedPromo({ promoterId: promoter.id, targetType: 'restaurant', targetId: promoRest.id, city: promoCity })
      const after = await api<PromoApiBody>(`/api/promotions/active?city=${encodeURIComponent(promoCity)}&type=restaurant`)
      assert(!(after.body.promotions ?? []).some(p => p.id === pending), 'a pending_review promo is not shown')

      // Nor does an unpaid one, even when active.
      const unpaid = await seedPromo({
        promoterId: promoter.id, targetType: 'restaurant', targetId: promoRest.id,
        city: promoCity, status: 'active', paymentStatus: 'pending',
      })
      const after2 = await api<PromoApiBody>(`/api/promotions/active?city=${encodeURIComponent(promoCity)}&type=restaurant`)
      assert(!(after2.body.promotions ?? []).some(p => p.id === unpaid),
        'an active-but-unpaid promo is not shown either')

      assertEq((await api<PromoApiBody>('/api/promotions/active?type=restaurant')).body.promotions, [],
        'a missing city returns an empty list rather than everything')
    })

    await step('#40 impression and click counters increment, and only while active', async () => {
      const id = await seedPromo({ promoterId: promoter.id, targetType: 'restaurant', targetId: promoRest.id, city: promoCity })

      // Pending: the counters must not move.
      assertEq((await api<PromoApiBody>(`/api/promotions/${id}/impression`, { method: 'POST' })).body.ok, false,
        'an impression on a pending promo is refused')
      assertEq((await api<PromoApiBody>(`/api/promotions/${id}/click`, { method: 'POST' })).body.ok, false,
        'a click on a pending promo is refused')
      let row = await promoRow(id)
      assertEq(row?.impressions, 0, 'impressions still 0')
      assertEq(row?.clicks, 0, 'clicks still 0')

      await approvePromo(id, admin)

      assertEq((await api<PromoApiBody>(`/api/promotions/${id}/impression`, { method: 'POST' })).body.ok, true,
        'an impression on an active promo is counted')
      assertEq((await api<PromoApiBody>(`/api/promotions/${id}/click`, { method: 'POST' })).body.ok, true,
        'and a click too')
      row = await promoRow(id)
      assertEq(row?.impressions, 1, 'impressions incremented by one')
      assertEq(row?.clicks, 1, 'clicks incremented by one')

      await api(`/api/promotions/${id}/impression`, { method: 'POST' })
      assertEq((await promoRow(id))?.impressions, 2, 'a second impression increments again')

      // An unknown id is a quiet no-op, not a 500.
      const unknown = await api<PromoApiBody>('/api/promotions/00000000-0000-0000-0000-000000000000/click', { method: 'POST' })
      assertEq(unknown.body.ok, false, 'a click on an unknown promo is a quiet no-op')
    })

    await step('#40 eligibility lists what the caller may promote', async () => {
      const r = await api<{ eligible?: boolean; restaurants?: Array<{ id: string }>; events?: Array<{ id: string }>; pricing?: unknown }>(
        '/api/promotions/eligibility', { cookie: customerCookie(promoter) })
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.eligible, true, 'a restaurant owner is eligible')
      assert((r.body.restaurants ?? []).some(x => x.id === promoRest.id), 'their restaurant is listed')
      assert(!!r.body.pricing, 'and the pricing table comes back for the compose form')

      const nobody = await makeCustomer({ suiteNo: 40, name: 'Promo Nobody' })
      const none = await api<{ eligible?: boolean; restaurants?: Array<unknown>; events?: Array<unknown> }>(
        '/api/promotions/eligibility', { cookie: customerCookie(nobody) })
      assertEq(none.body.eligible, false, 'someone with nothing to promote is not eligible')
      assertEq(none.body.restaurants, [], 'with an empty restaurant list')

      const anon = await api<{ eligible?: boolean }>('/api/promotions/eligibility')
      assertEq(anon.status, 200, 'anonymous gets 200, not 401')
      assertEq(anon.body.eligible, false, 'and is not eligible')
    })

    await step('#40 create is refused BEFORE any payment call — validation and eligibility', async () => {
      // Every case here must fail before promotions/route.ts reaches
      // createDeposit. None of them may create a promotions row.
      const cookie = customerCookie(promoter)
      const { count: before } = await sb.from('promotions')
        .select('*', { count: 'exact' }).eq('promoter_id', promoter.id).limit(0)

      const post = (body: Record<string, unknown>, c: string | null = cookie) =>
        api<PromoApiBody>('/api/promotions', { method: 'POST', body, ...(c ? { cookie: c } : {}) })

      const valid = {
        target_type: 'restaurant', target_id: promoRest.id, placement: 'feed_card',
        city: promoCity, start_date: '2030-01-01', end_date: '2030-01-05',
        phone_number: promoter.phone,
      }

      assertEq((await post(valid, null)).status, 401, 'no session → 401')
      assertEq((await post({ ...valid, target_type: 'nonsense' })).status, 400, 'bad target_type → 400')
      assertEq((await post({ ...valid, target_id: '' })).status, 400, 'missing target_id → 400')
      assertEq((await post({ ...valid, placement: 'billboard' })).status, 400, 'bad placement → 400')
      assertEq((await post({ ...valid, city: '' })).status, 400, 'missing city → 400')
      assertEq((await post({ ...valid, start_date: '' })).status, 400, 'missing dates → 400')
      assertEq((await post({ ...valid, start_date: '2030-01-10', end_date: '2030-01-01' })).status, 400,
        'end before start → 400')
      assertEq((await post({ ...valid, phone_number: '' })).status, 400, 'missing phone_number → 400')

      // Eligibility: someone else's restaurant, and a restaurant that exists
      // but the caller does not own.
      const otherRest = await makeRestaurant({ label: 'promo_not_mine' })
      assertEq((await post({ ...valid, target_id: otherRest.id })).status, 403,
        "promoting a restaurant you do not own → 403")
      assertEq((await post({ ...valid, target_type: 'event', target_id: otherRest.id })).status, 403,
        'promoting an event you do not organize → 403')

      const { count: after } = await sb.from('promotions')
        .select('*', { count: 'exact' }).eq('promoter_id', promoter.id).limit(0)
      assertEq(after ?? 0, before ?? 0,
        'NOT ONE refused create inserted a row — every case failed before the payment call')
    })

    // ══ #41 REPORTS ════════════════════════════════════════════════════════

    interface ReportApiBody { ok?: boolean; report_id?: string; error?: string }

    const submitReport = (body: Record<string, unknown>, cookie: string | null) =>
      api<ReportApiBody>('/api/reports', { method: 'POST', body, ...(cookie ? { cookie } : {}) })
    const patchReport = (id: string, body: Record<string, unknown>, cookie: string | null) =>
      api<ReportApiBody>(`/api/admin/reports/${id}`, { method: 'PATCH', body, ...(cookie ? { cookie } : {}) })

    const reportRow = async (id: string) => {
      const { data } = await sb.from('reports')
        .select('id, reporter_id, target_type, target_id, reason, status, admin_notes, reviewed_by')
        .eq('id', id).maybeSingle()
      return data as { id: string; reporter_id: string; target_type: string; target_id: string
                       reason: string; status: string; admin_notes: string | null; reviewed_by: string | null } | null
    }
    const trackReport = (b: ReportApiBody): string => {
      const id = b.report_id ?? ''
      if (id) track('reports', id)
      return id
    }

    const reportedRest = await makeRestaurant({ label: 'reported_rest' })

    await step('#41 a logged-in customer can report a restaurant', async () => {
      const reporter = await makeCustomer({ suiteNo: 41, name: 'Reporter One' })
      const r = await submitReport({
        target_type: 'restaurant', target_id: reportedRest.id,
        reason: 'spam', description: 'Test report',
      }, customerCookie(reporter))
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      const id = trackReport(r.body)
      assert(!!id, 'a report_id came back')

      const row = await reportRow(id)
      assertEq(row?.target_type, 'restaurant', 'the target type is recorded')
      assertEq(row?.target_id, reportedRest.id, 'and the target')
      assertEq(row?.reporter_id, reporter.id, 'the reporter is captured server-side from the session')
      assertEq(row?.status, 'pending', "status starts at 'pending'")
    })

    await step('#41 the reporter is never exposed outside the admin surface', async () => {
      const reporter = await makeCustomer({ suiteNo: 41, name: 'Anon Reporter' })
      const r = await submitReport({
        target_type: 'restaurant', target_id: reportedRest.id, reason: 'inappropriate',
      }, customerCookie(reporter))
      const id = trackReport(r.body)

      // The create response carries an id and nothing identifying.
      assertEq(Object.keys(r.body as Record<string, unknown>).sort(), ['ok', 'report_id'],
        'the response body is exactly { ok, report_id } — no reporter identity')
      assert(!r.raw.includes(reporter.id), 'the raw response does not contain the reporter id')
      assert(!r.raw.includes(reporter.phone), 'nor their phone')

      // There is no public read path at all: the only GET is admin-gated.
      const asStranger = await api(`/api/admin/reports?status=all`,
        { cookie: customerCookie(await makeCustomer({ suiteNo: 41, name: 'Nosy' })) })
      assertEq(asStranger.status, 401, 'a customer cannot list reports → 401')
      assert(!asStranger.raw.includes(reporter.phone), 'and the refusal leaks nothing')

      const asAnon = await api('/api/admin/reports?status=all')
      assertEq(asAnon.status, 401, 'anonymous cannot either → 401')

      // The admin CAN see it — that is the documented design.
      const asAdmin = await api<{ reports?: Array<{ id: string }> }>('/api/admin/reports?status=all', { cookie: admin })
      assertEq(asAdmin.status, 200, 'an admin can list reports → 200')
      assert((asAdmin.body.reports ?? []).some(x => x.id === id), 'and sees this report')

      // The reported party is never notified — no message row for the
      // restaurant's owner as a result of the report.
      const { count } = await sb.from('message_log')
        .select('*', { count: 'exact' }).eq('context', 'report_notice').limit(0)
      assertEq(count ?? 0, 0, 'no notification was sent to the reported party')
    })

    await step('#41 report validation', async () => {
      const reporter = await makeCustomer({ suiteNo: 41, name: 'Reporter Validation' })
      const cookie = customerCookie(reporter)
      const base = { target_type: 'restaurant', target_id: reportedRest.id, reason: 'spam' }

      assertEq((await submitReport(base, null)).status, 401, 'no session → 401')
      assertEq((await submitReport({ ...base, target_type: 'planet' }, cookie)).status, 400,
        'an unknown target_type → 400')
      assertEq((await submitReport({ ...base, reason: 'because' }, cookie)).status, 400,
        'an unknown reason → 400')
      assertEq((await submitReport({ ...base, target_id: '' }, cookie)).status, 400,
        'a missing target_id → 400')
      assertEq((await submitReport({ ...base, target_id: '00000000-0000-0000-0000-000000000000' }, cookie)).status, 404,
        'a target that does not exist → 404')
    })

    await step('#41 an admin can review, dismiss and annotate a report', async () => {
      const reporter = await makeCustomer({ suiteNo: 41, name: 'Reporter Moderated' })
      const cookie = customerCookie(reporter)

      const a = trackReport((await submitReport({
        target_type: 'restaurant', target_id: reportedRest.id, reason: 'spam' }, cookie)).body)
      const rev = await patchReport(a, { status: 'reviewed', admin_notes: 'Looked at it' }, admin)
      assertEq(rev.status, 200, 'reviewed → 200')
      let row = await reportRow(a)
      assertEq(row?.status, 'reviewed', "status='reviewed'")
      assertEq(row?.admin_notes, 'Looked at it', 'notes stored')
      assert(!!row?.reviewed_by, 'and the reviewing admin recorded')

      const b = trackReport((await submitReport({
        target_type: 'restaurant', target_id: reportedRest.id, reason: 'fake' }, cookie)).body)
      assertEq((await patchReport(b, { status: 'dismissed' }, admin)).status, 200, 'dismissed → 200')
      assertEq((await reportRow(b))?.status, 'dismissed', "status='dismissed'")

      // Invalid status and unknown id.
      assertEq((await patchReport(a, { status: 'resolved' }, admin)).status, 400,
        "'resolved' is not a valid status → 400 (the states are reviewed/action_taken/dismissed)")
      assertEq((await reportRow(a))?.status, 'reviewed', 'and the report is unchanged')
      assertEq((await patchReport('00000000-0000-0000-0000-000000000000', { status: 'reviewed' }, admin)).status, 404,
        'an unknown report → 404')
    })

    await step('#41 moderation is admin-only', async () => {
      const reporter = await makeCustomer({ suiteNo: 41, name: 'Reporter Authz' })
      const id = trackReport((await submitReport({
        target_type: 'restaurant', target_id: reportedRest.id, reason: 'spam',
      }, customerCookie(reporter))).body)

      assertEq((await patchReport(id, { status: 'dismissed' }, customerCookie(reporter))).status, 401,
        'the reporter cannot moderate their own report → 401')
      assertEq((await patchReport(id, { status: 'dismissed' }, null)).status, 401,
        'anonymous cannot → 401')
      assertEq((await reportRow(id))?.status, 'pending', 'and the report is still pending')
    })

    await step('#41 the 5-per-hour cap is enforced on the 6th report', async () => {
      // The limit is the subject here; every other #41 case above used its own
      // fresh reporter so none of them could be starved by it.
      const reporter = await makeCustomer({ suiteNo: 41, name: 'Report Limit' })
      const cookie = customerCookie(reporter)

      for (let i = 0; i < 5; i++) {
        const r = await submitReport({
          target_type: 'restaurant', target_id: reportedRest.id, reason: 'spam',
        }, cookie)
        assertEq(r.status, 200, `report ${i + 1} of 5 accepted`)
        trackReport(r.body)
      }

      const { count: before } = await sb.from('reports')
        .select('*', { count: 'exact' }).eq('reporter_id', reporter.id).limit(0)
      const sixth = await submitReport({
        target_type: 'restaurant', target_id: reportedRest.id, reason: 'spam',
      }, cookie)
      assertEq(sixth.status, 429, 'the 6th report in the window → 429')
      const { count: after } = await sb.from('reports')
        .select('*', { count: 'exact' }).eq('reporter_id', reporter.id).limit(0)
      assertEq(after ?? 0, before ?? 0, 'and it created no row')

      // A different reporter is unaffected — the cap is per session.
      const other = await makeCustomer({ suiteNo: 41, name: 'Other Reporter' })
      const ok = await submitReport({
        target_type: 'restaurant', target_id: reportedRest.id, reason: 'spam',
      }, customerCookie(other))
      assertEq(ok.status, 200, 'another customer can still report — the cap is per session')
      trackReport(ok.body)
    })

  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
