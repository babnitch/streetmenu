// Admin city filter (lib/adminCityServer.ts): every admin list API takes
// ?city= and filters on the server — restaurants, events, « Trouvés cette
// nuit », places, orders (+ the restaurant picker), problems, À payer,
// accounts. No city → every city; an unknown city is ignored (every city).
// Two per-run test cities, A and B.

import { sb, testName, RUN_ID } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeEvent, makeOrder, futureDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { titleKey } from '@/lib/discovery/dedupe'

const SUITE = 'api-admin-city-filter'
const A = testName('city')
const B = `__t_${RUN_ID}b_city__`

type Rows = Array<{ id: string }>
const ids = (rows: unknown): string[] => ((rows ?? []) as Rows).map(r => r.id)

async function main(): Promise<void> {
  try {
    const admin = await adminCookie()
    const ca = await makeCustomer({ suiteNo: 97, name: 'City A', city: A })
    const cb = await makeCustomer({ suiteNo: 97, name: 'City B', city: B })
    const ra = await makeRestaurant({ ownerId: ca.id, label: 'cf_rest_a', city: A, extra: { payout_phone_pending: '+237670000001' } })
    const rb = await makeRestaurant({ ownerId: cb.id, label: 'cf_rest_b', city: B, extra: { payout_phone_pending: '+237670000002' } })
    const ea = await makeEvent({ organizerId: ca.id, label: 'cf_ev_a', city: A, isActive: false, date: futureDateISO(5) })
    const eb = await makeEvent({ organizerId: cb.id, label: 'cf_ev_b', city: B, isActive: false, date: futureDateISO(5) })
    const oa = await makeOrder(ra.id, ca)
    const ob = await makeOrder(rb.id, cb)

    const cand = async (city: string, n: number) => {
      const title = testName(`cf_cand_${n}`)
      const { data, error } = await sb.from('event_candidates').insert({
        source_key: `https://t-${RUN_ID}.example/cf/${n}#x`, source_url: `https://t-${RUN_ID}.example/cf/${n}`, source_domain: `t-${RUN_ID}.example`,
        title, title_key: titleKey(title), start_date: futureDateISO(10), city,
      }).select('id').single()
      if (error) throw new Error(`candidate: ${error.message}`)
      track('event_candidates', data.id)
      return data.id as string
    }
    const cda = await cand(A, 1), cdb = await cand(B, 2)

    const place = async (city: string, label: string) => {
      const { data, error } = await sb.from('places').insert({ title_fr: testName(label), city, category: 'museums', status: 'pending' }).select('id').single()
      if (error) throw new Error(`place: ${error.message}`)
      track('places', data.id)
      return data.id as string
    }
    const pa = await place(A, 'cf_place_a'), pb = await place(B, 'cf_place_b')

    const problem = async (orderId: string) => {
      const { data, error } = await sb.from('order_problems').insert({ order_id: orderId, via: 'web', reason: 'test', status: 'open' }).select('id').single()
      if (error) return null
      track('order_problems', data.id)
      return data.id as string
    }
    const pra = await problem(oa.id), prb = await problem(ob.id)

    // [label, path, list key, id in A, id in B]
    const lists: Array<[string, string, string, string, string]> = [
      ['restaurants', '/api/admin/restaurants', 'restaurants', ra.id, rb.id],
      ['events', '/api/admin/events', 'events', ea.id, eb.id],
      ['found overnight', '/api/admin/event-candidates', 'candidates', cda, cdb],
      ['places', '/api/admin/places', 'places', pa, pb],
      ['orders', '/api/admin/orders', 'orders', oa.id, ob.id],
      ['order picker', '/api/admin/orders?only=restaurants', 'restaurants', ra.id, rb.id],
      ['accounts', '/api/admin/accounts', 'accounts', ca.id, cb.id],
    ]
    for (const [label, path, key, a, b] of lists) {
      await step(`${label}: ?city= filters on the server`, async () => {
        const sep = path.includes('?') ? '&' : '?'
        const one = await api<Record<string, unknown>>(`${path}${sep}city=${encodeURIComponent(A)}`, { cookie: admin })
        assertEq(one.status, 200, `${label} city A → 200`)
        const got = ids(one.body[key])
        assert(got.includes(a) && !got.includes(b), `${label}: A only (A ${got.includes(a)}, B ${got.includes(b)})`)
        const all = ids((await api<Record<string, unknown>>(path, { cookie: admin })).body[key])
        assert(all.includes(a) && all.includes(b), `${label}: no city → both`)
        const unknown = ids((await api<Record<string, unknown>>(`${path}${sep}city=Atlantis`, { cookie: admin })).body[key])
        assert(unknown.includes(a) && unknown.includes(b), `${label}: unknown city ignored → both`)
      })
    }

    await step('problems + À payer follow the city', async () => {
      const toPay = await api<{ rows: Array<{ restaurant_id: string }> }>(`/api/admin/payouts?city=${encodeURIComponent(A)}`, { cookie: admin })
      const pay = toPay.body.rows.map(r => r.restaurant_id)
      assert(pay.includes(ra.id) && !pay.includes(rb.id), 'À payer: A only')
      if (pra && prb) {
        const pr = await api<{ problems: Array<{ id: string }> }>(`/api/admin/problems?city=${encodeURIComponent(A)}`, { cookie: admin })
        const got = pr.body.problems.map(p => p.id)
        assert(got.includes(pra) && !got.includes(prb), 'problems: A only')
      } else {
        assert(false, 'could not create test problems')
      }
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
    finish(SUITE)
  }
}

void main()
