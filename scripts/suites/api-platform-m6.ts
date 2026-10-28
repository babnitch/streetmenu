// M6 — platform switches (Restaurants / Événements on-off).
//
// Admin only, audited. Off → customer APIs refuse (503 platform_off), the
// home rows and offers are empty, the bot answers "temporairement
// indisponible"; the restaurant's own tools keep working.
//
// SAFETY: the test server runs under the +999 send guard, so the switches
// it reads and writes are the test_* rows — the live platform's switches are
// never touched (asserted below). Both sides are switched back on in
// `finally`, whatever happens.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem, makeOrder, makeEvent } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-platform-m6'

interface Body { ok?: boolean; reason?: string; error?: string; restaurants?: unknown[]; events?: unknown[]; offers?: unknown[] }

const send = (phone: string, body: string) =>
  api('/api/whatsapp/incoming', { form: { From: `whatsapp:${phone}`, Body: body } })

async function liveSwitches(): Promise<Record<string, unknown>> {
  const { data } = await sb.from('platform_settings').select('key, value').in('key', ['restaurants_enabled', 'events_enabled'])
  return Object.fromEntries((data ?? []).map(r => [r.key, r.value]))
}

async function main(): Promise<void> {
  const admin = await adminCookie()
  const setSide = (body: Record<string, boolean>) => api<Body>('/api/admin/platform', { method: 'PUT', cookie: admin, body })
  const started = new Date().toISOString()
  const liveBefore = await liveSwitches()
  try {
    const buyer = await makeCustomer({ suiteNo: 76, name: 'M6 Buyer' })
    const owner = await makeCustomer({ suiteNo: 76, name: 'M6 Owner' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'm6_r', whatsapp: owner.phone })
    const dish = await makeMenuItem(rest.id, { price: 1500 })
    const bc = customerCookie(buyer)

    await step('admin only', async () => {
      assertEq((await api('/api/admin/platform', { method: 'PUT', cookie: bc, body: { restaurants: false } })).status, 401, 'a customer → 401')
      assertEq((await setSide({})).status, 400, 'nothing to change → 400')
    })

    await step('Restaurants off: orders, sign-ups, favourites refused; home and offers empty', async () => {
      const r = await setSide({ restaurants: false })
      assertEq(r.status, 200, `switched off (${r.raw.slice(0, 80)})`)
      const o = await api<Body>('/api/orders/create', { cookie: bc, body: { restaurant_id: rest.id, order_type: 'reservation', items: [{ id: dish.id, quantity: 1 }], total_price: 1500 } })
      assertEq(o.status, 503, 'order → 503')
      assertEq(o.body.reason, 'platform_off', 'reason platform_off')
      assert(/temporairement indisponibles/.test(o.body.error ?? ''), 'FR/EN "temporairement indisponibles"')
      assertEq((await api<Body>('/api/customer/favorites', { cookie: bc, body: { restaurant_id: rest.id } })).status, 503, 'favourite → 503')
      assertEq((await api<Body>('/api/restaurants/submit', { cookie: bc, body: {} })).status, 503, 'sign-up → 503')
      const pop = await api<Body>(`/api/popular?city=${encodeURIComponent('Yaoundé')}`)
      assertEq((pop.body.restaurants ?? []).length, 0, 'home: no restaurants')
      const off = await api<Body>(`/api/offers/today?city=${encodeURIComponent('Yaoundé')}`)
      assertEq((off.body.offers ?? []).length, 0, 'home: no offers')
      const st = await api<{ restaurants?: boolean; events?: boolean }>('/api/platform/status')
      assert(st.body.restaurants === false && st.body.events === true, 'status: restaurants off, events on')
    })

    await step('…the restaurant can still finish its orders; the bot says unavailable', async () => {
      const ord = await makeOrder(rest.id, buyer, { status: 'pending' })
      const s = await api<Body>(`/api/orders/${ord.id}/status`, { cookie: customerCookie(owner), body: { status: 'confirmed' } })
      assertEq(s.status, 200, `confirm an existing order → 200 (${s.raw.slice(0, 80)})`)
      await send(buyer.phone, 'fr')
      await send(buyer.phone, 'commander')
      const { data } = await sb.from('message_log').select('body').like('to_number', `%${buyer.phone.replace('+', '')}%`)
        .order('created_at', { ascending: false }).limit(1)
      assert(/temporairement indisponibles/.test(String(data?.[0]?.body ?? '')), 'bot: temporarily unavailable')
    })

    await step('Événements off: bookings and submits refused; Restaurants back on', async () => {
      assertEq((await setSide({ restaurants: true, events: false })).status, 200, 'switched')
      const org = await makeCustomer({ suiteNo: 76, name: 'M6 Organiser' })
      const ev = await makeEvent({ organizerId: org.id, label: 'm6_event', isActive: true })
      const r = await api<Body & { reservation_id?: string }>(`/api/events/${ev.id}/reserve`, { cookie: bc, body: { quantity: 1 } })
      if (r.body.reservation_id) track('event_reservations', r.body.reservation_id)
      assertEq(r.status, 503, 'reserve → 503')
      assertEq((await api<Body>('/api/events/submit', { cookie: customerCookie(org), body: {} })).status, 503, 'submit → 503')
      const o = await api<Body & { order?: { id: string } }>('/api/orders/create', { cookie: bc, body: { restaurant_id: rest.id, order_type: 'reservation', items: [{ id: dish.id, quantity: 1 }], total_price: 1500 } })
      if (o.body.order) track('orders', o.body.order.id)
      assertEq(o.status, 200, 'restaurants back → order 200')
    })

    await step('audited; the live switches were never touched', async () => {
      const { data } = await sb.from('audit_log').select('id').eq('action', 'platform_switch_updated').gte('created_at', started)
      assert((data ?? []).length >= 3, 'switch changes audited')
      assertEq(await liveSwitches(), liveBefore, 'restaurants_enabled / events_enabled unchanged')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await setSide({ restaurants: true, events: true })
    // This run's audit rows (test_* switches only).
    await sb.from('audit_log').delete().eq('action', 'platform_switch_updated').gte('created_at', started)
      .or('metadata->>test_restaurants_enabled.not.is.null,metadata->>test_events_enabled.not.is.null')
    await teardown()
  }
  finish(SUITE)
}

void main()
