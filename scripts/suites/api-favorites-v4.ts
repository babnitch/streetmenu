// V4 — favourites and the restaurant/info pages' data, over HTTP.
//
// /api/customer/favorites: customer session only; add (idempotent), status,
// list (with the restaurant), remove; unknown restaurant → 404.
// /api/restaurants/open-status gives the closing time ("Ouvert jusqu'à").
//
// Every phone is +999.

import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'
import { sb } from '../testkit/env'

const SUITE = 'api-favorites-v4'

interface FavList { favorites?: Array<{ restaurant_id: string; restaurant?: { id: string; name: string } | null }> }

async function main(): Promise<void> {
  try {
    const me = await makeCustomer({ suiteNo: 70, name: 'Fav Customer' })
    const other = await makeCustomer({ suiteNo: 70, name: 'Fav Other' })
    const rest = await makeRestaurant({ label: 'fav_r' })
    const cookie = customerCookie(me)
    const fav = (opts: { method?: string; body?: unknown; query?: string; cookie?: string } = {}) =>
      api<{ ok?: boolean; favorite?: boolean } & FavList>(`/api/customer/favorites${opts.query ?? ''}`,
        { cookie: opts.cookie ?? cookie, method: opts.method, body: opts.body })

    await step('logged out → 401; bad or unknown restaurant refused', async () => {
      assertEq((await api('/api/customer/favorites', { body: { restaurant_id: rest.id } })).status, 401, 'POST logged out → 401')
      assertEq((await api(`/api/customer/favorites?restaurant_id=${rest.id}`)).status, 401, 'GET logged out → 401')
      assertEq((await fav({ body: { restaurant_id: 'nope' } })).status, 400, 'bad id → 400')
      assertEq((await fav({ body: { restaurant_id: '00000000-0000-0000-0000-000000000000' } })).status, 404, 'unknown restaurant → 404')
    })

    await step('add (twice is fine), status, list with the restaurant', async () => {
      assertEq((await fav({ query: `?restaurant_id=${rest.id}` })).body.favorite, false, 'not a favourite yet')
      assertEq((await fav({ body: { restaurant_id: rest.id } })).status, 200, 'add → 200')
      assertEq((await fav({ body: { restaurant_id: rest.id } })).status, 200, 'add again → 200')
      assertEq((await fav({ query: `?restaurant_id=${rest.id}` })).body.favorite, true, 'now a favourite')
      const list = await fav()
      const rows = (list.body.favorites ?? []).filter(f => f.restaurant_id === rest.id)
      assertEq(rows.length, 1, 'listed once')
      assertEq(rows[0]?.restaurant?.id, rest.id, 'with the restaurant')
      assertEq((await fav({ query: `?restaurant_id=${rest.id}`, cookie: customerCookie(other) })).body.favorite, false, 'not someone else\'s favourite')
    })

    await step('remove', async () => {
      assertEq((await fav({ method: 'DELETE', query: `?restaurant_id=${rest.id}` })).status, 200, 'remove → 200')
      assertEq((await fav({ query: `?restaurant_id=${rest.id}` })).body.favorite, false, 'gone')
      const { count } = await sb.from('customer_favorites').select('customer_id', { count: 'exact', head: true }).eq('customer_id', me.id)
      assertEq(count ?? 0, 0, 'no row left')
    })

    await step('open-status gives the closing time for "Ouvert jusqu\'à"', async () => {
      await sb.from('restaurants').update({ manual_override: null, timezone: 'Africa/Douala' }).eq('id', rest.id)
      const rows = [0, 1, 2, 3, 4, 5, 6].map(d => ({ restaurant_id: rest.id, day_of_week: d, open_time: '00:00', close_time: '23:59', is_closed: false }))
      const { error } = await sb.from('restaurant_hours').insert(rows as never)
      assert(!error, `hours inserted (${error?.message ?? ''})`)
      const r = await api<{ status?: Record<string, { open: boolean; next_kind?: string; next_at?: string }> }>(`/api/restaurants/open-status?ids=${rest.id}`)
      const s = r.body.status?.[rest.id]
      assert(s?.open === true && s?.next_kind === 'closes' && s?.next_at === '23:59', `open, closes at 23:59 (got ${JSON.stringify(s)})`)
      await sb.from('restaurant_hours').delete().eq('restaurant_id', rest.id)
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
