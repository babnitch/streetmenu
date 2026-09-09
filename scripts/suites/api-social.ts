// TEST-PLAN.md §1c #38 (ratings) and #39 (subscriptions, HTTP half).
// #40 promotions and #41 reports land as a second commit.
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
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
