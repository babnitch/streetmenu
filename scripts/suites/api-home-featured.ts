// "À la une" (lib/homeFeatured.ts), over HTTP.
//
//   - fallback without an admin pick: the next is_featured event with a real
//     photo, else the next event with a photo, else no card; never an event
//     without a photo, an inactive one or one that is over;
//   - Admin → À la une (admin only): pick a restaurant / event / place for a
//     date range; the newest running pick wins; a pick that is no longer live
//     (inactive, event over) is skipped; remove = soft delete; audited;
//   - the button: Commander (restaurant taking orders, not paused) /
//     Réserver (bookable event) / Voir;
//   - public key: the pick columns only, removed picks hidden.
//
// Before supabase-home-featured.sql: the fallback works and adding a pick
// answers 503 (warning, not failure).

import { sb, testName, getAnon, RUN_ID } from '../testkit/env'
import { assert, assertEq, step, finish, warn } from '../testkit/assert'
import { api, adminCookie, customerCookie } from '../testkit/session'
import { makeCustomer, makeEvent, makeRestaurant, futureDateISO, pastDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { validateFeaturedInput, featuredActionLabel } from '../../lib/homeFeatured'
import { todayInDouala } from '../../lib/weekend'
import { HOME_FEATURED_COLUMNS } from '../../lib/publicColumns'

const SUITE = 'api-home-featured'
const CITY = testName('city')
const EMPTY_CITY = testName('city', `${RUN_ID}e`)   // a test city the server accepts, with nothing in it
const OTHER_CITY = testName('city_other')
const PHOTO = 'https://example.com/featured.jpg'

interface Card { type: string; id: string; action: string; source: string; image: string | null; when: { date: string } | null }
const home = async (city = CITY) => (await api<{ item: Card | null }>(`/api/home/featured?city=${encodeURIComponent(city)}`)).body.item

async function main(): Promise<void> {
  try {
    const today = todayInDouala()

    await step('unit: admin input check and button labels', async () => {
      const id = '11111111-1111-4111-8111-111111111111'
      const ok = validateFeaturedInput({ city: 'Douala', item_type: 'event', item_id: id, starts_on: today, ends_on: today }, today)
      assert(ok.ok, 'valid input accepted')
      assert(!validateFeaturedInput({ city: 'Douala', item_type: 'menu', item_id: id, starts_on: today, ends_on: today }, today).ok, 'bad type refused')
      assert(!validateFeaturedInput({ city: 'Douala', item_type: 'event', item_id: 'x', starts_on: today, ends_on: today }, today).ok, 'bad id refused')
      assert(!validateFeaturedInput({ city: 'Douala', item_type: 'event', item_id: id, starts_on: futureDateISO(3), ends_on: futureDateISO(1) }, today).ok, 'end before start refused')
      assert(!validateFeaturedInput({ city: 'Douala', item_type: 'event', item_id: id, starts_on: pastDateISO(5), ends_on: pastDateISO(2) }, today).ok, 'range already over refused')
      assert(!validateFeaturedInput({ city: '', item_type: 'event', item_id: id, starts_on: today, ends_on: today }, today).ok, 'no city refused')
      assertEq([featuredActionLabel('book', 'fr'), featuredActionLabel('order', 'fr'), featuredActionLabel('view', 'fr')], ['Réserver', 'Commander', 'Voir'], 'FR labels')
      assertEq([featuredActionLabel('book', 'en'), featuredActionLabel('order', 'en'), featuredActionLabel('view', 'en')], ['Book', 'Order', 'View'], 'EN labels')
    })

    const ev = (label: string, date: string, extra: Record<string, unknown>, isActive = true) =>
      makeEvent({ label, city: CITY, date, isActive, extra })
    const noPhoto = await ev('f_nophoto', futureDateISO(2), { cover_photo: null, is_featured: true })
    const next = await ev('f_next', futureDateISO(5), { cover_photo: PHOTO })
    const star = await ev('f_star', futureDateISO(10), { cover_photo: PHOTO, is_featured: true })
    await ev('f_over', pastDateISO(3), { cover_photo: PHOTO, is_featured: true })
    const off = await ev('f_off', futureDateISO(1), { cover_photo: PHOTO, is_featured: true }, false)
    const elsewhere = await makeEvent({ label: 'f_elsewhere', city: OTHER_CITY, isActive: true, extra: { cover_photo: PHOTO } })
    const rest = await makeRestaurant({ label: 'f_rest', city: CITY, extra: { image_url: PHOTO } })
    const { data: place, error: placeErr } = await sb.from('places')
      .insert({ title_fr: testName('f_place'), city: CITY, category: 'museums', status: 'active', cover_url: PHOTO } as never).select('id').single()
    if (placeErr) throw new Error(`insert place: ${placeErr.message}`)
    track('places', (place as { id: string }).id)
    const placeId = (place as { id: string }).id

    await step('fallback: next featured event with a photo (not one without photo, inactive or over)', async () => {
      const c = await home()
      assertEq(c?.id, star.id, 'the featured event with a photo')
      assertEq(c?.source, 'featured_event', 'source = featured event')
      assertEq(c?.image, PHOTO, 'real photo')
      assertEq(c?.action, 'book', 'button = Réserver')
      assert(c?.id !== noPhoto.id && c?.id !== off.id, 'never the no-photo or inactive one')
    })

    await step('fallback: no featured event → the next event with a photo', async () => {
      await sb.from('events').update({ is_featured: false } as never).eq('id', star.id)
      const c = await home()
      assertEq(c?.id, next.id, 'the next event with a photo')
      assertEq(c?.source, 'next_event', 'source = next event')
      await sb.from('events').update({ is_featured: true } as never).eq('id', star.id)
    })

    await step('no event with a photo → no card; unknown city refused', async () => {
      assertEq(await home(EMPTY_CITY), null, 'no card')
      const r = await api(`/api/home/featured?city=Nowhere`)
      assertEq(r.status, 400, 'unknown city → 400')
    })

    await step('admin only', async () => {
      const buyer = await makeCustomer({ suiteNo: 43, name: 'Featured Buyer' })
      const r1 = await api(`/api/admin/featured?city=${encodeURIComponent(CITY)}`)
      assertEq(r1.status, 401, 'no session → 401')
      const r2 = await api(`/api/admin/featured?city=${encodeURIComponent(CITY)}`, { cookie: customerCookie(buyer) })
      assertEq(r2.status, 401, 'customer → 401')
      const r3 = await api('/api/admin/featured', { cookie: customerCookie(buyer), body: { city: CITY, item_type: 'restaurant', item_id: rest.id, starts_on: today, ends_on: today } })
      assertEq(r3.status, 401, 'customer cannot add')
    })

    const admin = await adminCookie()
    const list = async () => (await api<{ available: boolean; picks: Array<{ id: string; state: string; live: boolean }>; current: Card | null }>(
      `/api/admin/featured?city=${encodeURIComponent(CITY)}`, { cookie: admin })).body
    const add = async (item_type: string, item_id: string, starts_on = today, ends_on = futureDateISO(3)) => {
      const r = await api<{ id?: string; error?: string }>('/api/admin/featured', { cookie: admin, body: { city: CITY, item_type, item_id, starts_on, ends_on } })
      if (r.body.id) track('home_featured', r.body.id)
      return r
    }

    const first = await list()
    if (!first.available) {
      await step('before the SQL: the admin page says so, adding answers 503', async () => {
        assertEq(first.current?.id, star.id, 'admin sees the fallback card')
        const r = await add('restaurant', rest.id)
        assertEq(r.status, 503, `add → 503 (${r.body.error})`)
      })
      warn('home_featured table missing', 'run supabase-home-featured.sql, then re-run api-home-featured')
      return
    }

    await step('search: live items of the city only', async () => {
      const r = await api<{ results: Array<{ id: string; type: string }> }>(
        `/api/admin/featured?city=${encodeURIComponent(CITY)}&q=${encodeURIComponent('f_')}`, { cookie: admin })
      const ids = (r.body.results ?? []).map(x => x.id)
      assert(ids.includes(star.id) && ids.includes(rest.id) && ids.includes(placeId), 'event, restaurant and place found')
      assert(!ids.includes(off.id), 'inactive event not offered')
      assert(!ids.includes(elsewhere.id), 'other city not offered')
    })

    let restPick = ''
    await step('pick a restaurant → the card, button Commander', async () => {
      const r = await add('restaurant', rest.id)
      assertEq(r.status, 200, `added (${r.body.error ?? 'ok'})`)
      restPick = r.body.id ?? ''
      const c = await home()
      assertEq(c?.id, rest.id, 'restaurant on the home page')
      assertEq(c?.source, 'pick', 'source = admin pick')
      assertEq(c?.action, 'order', 'button = Commander')
    })

    await step('restaurant with online orders paused → button Voir', async () => {
      const { error } = await sb.from('restaurants').update({ orders_paused_at: new Date(Date.now() - 60_000).toISOString(), orders_paused_until: null } as never).eq('id', rest.id)
      if (error) { warn('orders pause columns missing', 'skipped'); return }
      assertEq((await home())?.action, 'view', 'button = Voir')
      await sb.from('restaurants').update({ orders_paused_at: null, orders_paused_until: null } as never).eq('id', rest.id)
    })

    await step('refused: other city, inactive, bad dates', async () => {
      assertEq((await add('event', elsewhere.id)).status, 400, 'event of another city → 400')
      assertEq((await add('event', off.id)).status, 400, 'inactive event → 400')
      assertEq((await add('restaurant', rest.id, futureDateISO(3), futureDateISO(1))).status, 400, 'end before start → 400')
    })

    let placePick = ''
    await step('newest running pick wins; a future pick waits', async () => {
      const later = await add('event', next.id, futureDateISO(1), futureDateISO(4))
      assertEq(later.status, 200, 'future pick added')
      assertEq((await home())?.id, rest.id, 'a pick starting tomorrow is not shown yet')
      const r = await add('place', placeId)
      assertEq(r.status, 200, 'place pick added')
      placePick = r.body.id ?? ''
      const c = await home()
      assertEq(c?.id, placeId, 'newest pick (place) shown')
      assertEq(c?.action, 'view', 'button = Voir')
    })

    await step('remove = soft delete, audited; the previous pick comes back', async () => {
      const r = await api(`/api/admin/featured/${placePick}`, { cookie: admin, method: 'DELETE' })
      assertEq(r.status, 200, 'removed')
      const { data: row } = await sb.from('home_featured').select('deleted_at, deleted_by').eq('id', placePick).maybeSingle()
      assert(!!row?.deleted_at && !!row?.deleted_by, 'row kept with deleted_at + deleted_by')
      assertEq((await home())?.id, rest.id, 'restaurant back on the home page')
      const again = await api(`/api/admin/featured/${placePick}`, { cookie: admin, method: 'DELETE' })
      assertEq(again.status, 404, 'removing twice → 404')
      const { count: set } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('action', 'home_featured_set').eq('target_id', placePick)
      const { count: removed } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('action', 'home_featured_removed').eq('target_id', placePick)
      assertEq([set, removed], [1, 1], 'audit: set + removed')
    })

    await step('a picked event that ends disappears by itself', async () => {
      const r = await add('event', star.id)
      assertEq(r.status, 200, 'event pick added')
      assertEq((await home())?.id, star.id, 'event shown (newest pick)')
      assertEq((await home())?.source, 'pick', 'as a pick')
      await sb.from('events').update({ date: pastDateISO(2), end_date: null } as never).eq('id', star.id)
      assertEq((await home())?.id, rest.id, 'over → the next running pick')
      const l = await list()
      assert(l.picks.some(p => p.id === r.body.id && !p.live), 'admin list marks it not live')
    })

    await step('a picked restaurant switched off is skipped', async () => {
      await sb.from('restaurants').update({ is_active: false } as never).eq('id', rest.id)
      const c = await home()
      assert(c?.id !== rest.id, 'restaurant gone')
      assertEq(c?.id, next.id, 'fallback: next event with a photo')
      await sb.from('restaurants').update({ is_active: true } as never).eq('id', rest.id)
    })

    await step('public key: pick columns only, removed picks hidden', async () => {
      const a = await getAnon().from('home_featured').select(HOME_FEATURED_COLUMNS.join(', ')).eq('city', CITY)
      assert(!a.error, `readable (${a.error?.message ?? 'ok'})`)
      const ids = ((a.data ?? []) as unknown as Array<{ id: string }>).map(x => x.id)
      assert(ids.includes(restPick), 'running pick visible')
      assert(!ids.includes(placePick), 'removed pick hidden')
      const p = await getAnon().from('home_featured').select('created_by').limit(1)
      assertEq(p.error?.code, '42501', 'created_by refused')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
    finish(SUITE)
  }
}

void main()
