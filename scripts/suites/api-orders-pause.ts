// "Commandes en ligne en pause" (lib/ordersPause.ts) over HTTP and WhatsApp.
//
//   - never paused by default; only owner / manager / admin can pause;
//   - while paused the server refuses every new order (reservation, paid,
//     WhatsApp — also an order confirmed after the pause started mid-chat)
//     and any payment for an order placed during the pause;
//   - orders placed before the pause carry on;
//   - a timed pause ends by itself; pause / resume are audited;
//   - bot commands "pause 1h" / "reprendre" (owner), refused for staff.
//
// Before supabase-orders-pause.sql has run the columns don't exist: the
// suite then checks that nothing is blocked and the switch reports
// "not available", and warns that the rest waits for the SQL.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, warn, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem, makeOrder, addTeamMember } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { parseBotPauseCommand, isOrdersPaused } from '@/lib/ordersPause'

const SUITE = 'api-orders-pause'

interface PauseBody { available?: boolean; paused?: boolean; until?: string | null; error?: string; reason?: string }
interface CreateBody { ok?: boolean; order?: { id: string }; reason?: string; phone?: string | null }

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const send = (from: string, body: string) => api('/api/whatsapp/incoming', { form: { From: `whatsapp:${from}`, Body: body } })

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 6000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(150)
  }
  return null
}

async function main(): Promise<void> {
  try {
    await step('unit: bot commands and the paused test', async () => {
      assertEq(parseBotPauseCommand('pause'), { kind: 'pause', choice: 'manual' }, '"pause" = until turned back on')
      assertEq(parseBotPauseCommand('pause 1h'), { kind: 'pause', choice: 'minutes', minutes: 60 }, '"pause 1h"')
      assertEq(parseBotPauseCommand('pause 30 min'), { kind: 'pause', choice: 'minutes', minutes: 30 }, '"pause 30 min"')
      assertEq(parseBotPauseCommand('pause soir'), { kind: 'pause', choice: 'closing' }, '"pause soir"')
      assertEq(parseBotPauseCommand('reprendre'), { kind: 'resume' }, '"reprendre"')
      assertEq(parseBotPauseCommand('resume'), { kind: 'resume' }, '"resume"')
      assertEq(parseBotPauseCommand('pause 99h'), { kind: 'bad' }, 'more than 12 h refused')
      assertEq(parseBotPauseCommand('pauses'), null, 'other words untouched')
      const now = new Date()
      assertEq(isOrdersPaused({ orders_paused_at: null, orders_paused_until: null }, now), false, 'default = open')
      assertEq(isOrdersPaused({ orders_paused_at: now.toISOString(), orders_paused_until: null }, now), true, 'no end = paused')
      assertEq(isOrdersPaused({ orders_paused_at: now.toISOString(), orders_paused_until: new Date(now.getTime() - 1000).toISOString() }, now), false, 'ended = open')
    })

    const city    = testName('city')
    const owner   = await makeCustomer({ suiteNo: 41, name: 'Owner' })
    const manager = await makeCustomer({ suiteNo: 41, name: 'Manager' })
    const staff   = await makeCustomer({ suiteNo: 41, name: 'Staff' })
    const buyer   = await makeCustomer({ suiteNo: 41, name: 'Buyer', city })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'pause', whatsapp: owner.phone, city })
    await addTeamMember(rest.id, manager.id, 'manager')
    await addTeamMember(rest.id, staff.id, 'staff')
    const dish = await makeMenuItem(rest.id, { name: 'Ndolé', price: 2500 })
    await sb.from('signup_sessions').delete().in('phone', [owner.phone, buyer.phone, staff.phone])

    const C = { owner: customerCookie(owner), manager: customerCookie(manager), staff: customerCookie(staff), buyer: customerCookie(buyer) }
    const pauseUrl = `/api/restaurants/${rest.id}/orders-pause`
    const createOrder = async (orderType: 'reservation' | 'paid_order') => {
      const r = await api<CreateBody>('/api/orders/create', {
        cookie: C.buyer, body: { restaurant_id: rest.id, items: [{ id: dish.id, quantity: 1 }], total_price: 2500, order_type: orderType, fulfilment: 'pickup' },
      })
      track('orders', r.body.order?.id)
      return r
    }

    const first = await api<PauseBody>(pauseUrl)
    if (!first.body.available) {
      await step('before the SQL: nothing blocked, switch hidden', async () => {
        assertEq(first.status, 200, 'GET 200')
        assertEq(first.body.paused, false, 'not paused')
        assertEq((await api(pauseUrl, { cookie: C.owner, body: { pause: '1h' } })).status, 503, 'pausing answers 503 (not available yet)')
        const o = await createOrder('reservation')
        assertEq(o.status, 200, `orders still taken (body ${o.raw.slice(0, 160)})`)
      })
      warn('orders pause columns missing', 'run supabase-orders-pause.sql, then re-run this suite')
      return
    }

    await step('a new restaurant takes orders (never paused by default)', async () => {
      assertEq(first.body.paused, false, 'not paused')
      const { data } = await sb.from('restaurants').select('orders_paused_at, orders_paused_until').eq('id', rest.id).single()
      assertEq(data, { orders_paused_at: null, orders_paused_until: null }, 'both columns empty')
    })

    await step('only owner / manager / admin can pause', async () => {
      assertEq((await api(pauseUrl, { body: { pause: '1h' } })).status, 401, 'logged out → 401')
      assertEq((await api(pauseUrl, { cookie: C.staff, body: { pause: '1h' } })).status, 403, 'staff → 403')
      assertEq((await api(pauseUrl, { cookie: C.buyer, body: { pause: '1h' } })).status, 403, 'customer → 403')
      assertEq((await api(pauseUrl, { cookie: C.owner, body: { pause: '2h' } })).status, 400, 'unknown choice → 400')
      assertEq((await api<PauseBody>(pauseUrl)).body.paused, false, 'still open')
    })

    let before = ''
    await step('owner pauses 30 min: page and checkout see it', async () => {
      before = (await makeOrder(rest.id, buyer, { status: 'pending' })).id
      // created_at is the database clock, the pause start the server's: a
      // second apart either way keeps "before" / "during" unambiguous.
      await sleep(1500)
      const r = await api<PauseBody>(pauseUrl, { cookie: C.owner, body: { pause: '30m' } })
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.paused, true, 'paused')
      const mins = (new Date(r.body.until ?? 0).getTime() - Date.now()) / 60_000
      assert(mins > 28 && mins <= 30.1, `ends in ~30 min (${mins.toFixed(1)})`)
      assertEq((await api<PauseBody>(pauseUrl)).body.paused, true, 'public GET says paused')
    })

    await step('server refuses every new order while paused', async () => {
      for (const t of ['reservation', 'paid_order'] as const) {
        const r = await createOrder(t)
        assertEq(r.status, 409, `${t} → 409`)
        assertEq(r.body.reason, 'orders_paused', `${t} reason orders_paused`)
      }
    })

    await step('no payment for an order placed during the pause; earlier ones unaffected', async () => {
      await sleep(1500)
      const during = (await makeOrder(rest.id, buyer, { extra: { order_type: 'paid_order', payment_status: 'pending' } })).id
      const r = await api<PauseBody>('/api/payments/initiate', { body: { orderId: during, phoneNumber: '+237653456789' } })
      assertEq(r.status, 409, 'payment refused (409)')
      assertEq(r.body.reason, 'orders_paused', 'reason orders_paused')
      const early = await api<PauseBody>('/api/payments/initiate', { body: { orderId: before, phoneNumber: '+237653456789' } })
      assert(early.body.reason !== 'orders_paused', `order from before the pause not refused for the pause (${early.status})`)
      const s = await api(`/api/orders/${before}/status`, { cookie: C.owner, body: { status: 'confirmed' } })
      assertEq(s.status, 200, 'an order from before the pause can still be confirmed')
    })

    await step('a timed pause ends by itself', async () => {
      await sb.from('restaurants').update({ orders_paused_until: new Date(Date.now() - 1000).toISOString() } as never).eq('id', rest.id)
      assertEq((await api<PauseBody>(pauseUrl)).body.paused, false, 'open again')
      const r = await createOrder('reservation')
      assertEq(r.status, 200, `orders taken again (body ${r.raw.slice(0, 160)})`)
    })

    await step('"until closing" and "until turned back on"; manager / admin resume', async () => {
      const c = await api<PauseBody>(pauseUrl, { cookie: C.manager, body: { pause: 'closing' } })
      assertEq(c.status, 200, 'manager can pause')
      const mins = (new Date(c.body.until ?? 0).getTime() - Date.now()) / 60_000
      assert(mins > 0 && mins <= 24 * 60, `ends tonight (${mins.toFixed(0)} min)`)
      const m = await api<PauseBody>(pauseUrl, { cookie: C.owner, body: { pause: 'manual' } })
      assertEq([m.body.paused, m.body.until], [true, null], 'manual: paused, no end')
      const r = await api<PauseBody>(pauseUrl, { cookie: await adminCookie(), body: { resume: true } })
      assertEq(r.body.paused, false, 'admin resumes')
      const { data } = await sb.from('audit_log').select('action').eq('target_id', rest.id).in('action', ['orders_paused', 'orders_resumed'])
      const actions = (data ?? []).map(a => a.action as string)
      assert(actions.filter(a => a === 'orders_paused').length >= 3 && actions.includes('orders_resumed'), `audited (${actions.join(', ')})`)
    })

    await step('WhatsApp: staff can\'t pause; owner "pause 1h" / "reprendre"', async () => {
      await send(staff.phone, 'pause')
      await sleep(800)
      assertEq((await api<PauseBody>(pauseUrl)).body.paused, false, 'staff "pause" ignored')
      await send(owner.phone, 'pause 1h')
      const p = await waitFor(async () => { const b = (await api<PauseBody>(pauseUrl)).body; return b.paused ? b : null })
      assert(!!p, 'owner "pause 1h" pauses')
      const mins = (new Date(p?.until ?? 0).getTime() - Date.now()) / 60_000
      assert(mins > 58 && mins <= 60.1, `for 1 h (${mins.toFixed(1)})`)
      await send(owner.phone, 'reprendre')
      const r = await waitFor(async () => { const b = (await api<PauseBody>(pauseUrl)).body; return b.paused === false ? b : null })
      assert(!!r, '"reprendre" reopens')
    })

    await step('WhatsApp: a paused restaurant takes no bot order, even one already in progress', async () => {
      await send(buyer.phone, 'commander')
      const s1 = await waitFor(async () => {
        const { data } = await sb.from('signup_sessions').select('step, data').eq('phone', buyer.phone).maybeSingle()
        return data?.step === 1 ? data : null
      })
      const idx = ((s1?.data as { candidates?: Array<{ id: string }> } | undefined)?.candidates ?? []).findIndex(c => c.id === rest.id)
      assert(idx >= 0, 'restaurant listed (still open)')
      await send(buyer.phone, String(idx + 1))
      await waitFor(async () => {
        const { data } = await sb.from('signup_sessions').select('step').eq('phone', buyer.phone).maybeSingle()
        return data?.step === 2 ? data : null
      })
      await send(buyer.phone, '1 x1')
      await waitFor(async () => {
        const { data } = await sb.from('signup_sessions').select('step').eq('phone', buyer.phone).maybeSingle()
        return data?.step === 3 ? data : null
      })
      // Paused between the summary and "oui".
      assertEq((await api<PauseBody>(pauseUrl, { cookie: C.owner, body: { pause: 'manual' } })).body.paused, true, 'paused mid-chat')
      const { count: n0 } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('customer_id', buyer.id)
      await send(buyer.phone, 'oui')
      const gone = await waitFor(async () => {
        const { data } = await sb.from('signup_sessions').select('step').eq('phone', buyer.phone).maybeSingle()
        return data ? null : true
      })
      assert(!!gone, 'session closed')
      const { count: n1 } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('customer_id', buyer.id)
      assertEq(n1, n0, 'no order created')

      // And a new conversation stops at the restaurant choice.
      await send(buyer.phone, 'commander')
      await waitFor(async () => {
        const { data } = await sb.from('signup_sessions').select('step').eq('phone', buyer.phone).maybeSingle()
        return data?.step === 1 ? data : null
      })
      await send(buyer.phone, String(idx + 1))
      await sleep(1200)
      const { data: s } = await sb.from('signup_sessions').select('step').eq('phone', buyer.phone).maybeSingle()
      assert(!s, 'no menu step while paused')
      await api(pauseUrl, { cookie: C.owner, body: { resume: true } })
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    // Bot-made orders aren't in the ledger: none should exist, but sweep anyway.
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
    finish(SUITE)
  }
}

void main()
