// Validating is a Pro action — on the server too. A session whose account
// is in Client mode (customers.default_mode) is refused (403 client_mode)
// when it validates a QR, types a rider delivery code or marks a guest
// present; nothing changes. After "Passer en mode Pro" (PATCH
// /api/customer/mode) the same request works. Opening a QR still changes
// nothing; the owner sees their own item in either mode; admins have no
// mode. Every phone is +999; per-run city.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeEvent, makeRestaurant, makeOrder } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { ensureScanToken, deliveryCode } from '../../lib/scanTokens'
import { dateInZone } from '../../lib/offers'

const SUITE = 'api-scan-mode'
const CITY = testName('city')

interface Body { ok?: boolean; reason?: string; error?: string; access?: string; action?: string; state?: string; reservation_ids?: string[] }

async function main(): Promise<void> {
  try {
    const org = await makeCustomer({ suiteNo: 92, name: 'Mode Organiser' })          // Client mode (default)
    const buyer = await makeCustomer({ suiteNo: 92, name: 'Mode Buyer', extra: { city: CITY } })
    const oc = customerCookie(org)
    const ev = await makeEvent({ organizerId: org.id, label: 'scanmode_ev', isActive: true, date: dateInZone('Africa/Douala'), city: CITY })
    const book = async () => {
      const r = await api<Body>(`/api/events/${ev.id}/reserve`, { cookie: customerCookie(buyer), body: { quantity: 2 } })
      for (const id of r.body.reservation_ids ?? []) track('event_reservations', id)
      return r.body.reservation_ids![0]
    }
    const r1 = await book()
    const t1 = await ensureScanToken('reservation', r1)

    await step('Client mode: the server refuses to validate; nothing changes', async () => {
      const v = await api<Body>(`/api/scan/${t1}`, { cookie: oc })
      assertEq([v.body.access, v.body.action], ['staff', 'checkin'], 'allowed to validate (the page asks to switch)')
      const p = await api<Body>(`/api/scan/${t1}`, { method: 'POST', cookie: oc, body: {} })
      assertEq([p.status, p.body.reason], [403, 'client_mode'], '403 client_mode')
      assert(/mode Pro/.test(p.body.error ?? '') && /Pro mode/.test(p.body.error ?? ''), 'FR/EN')
      const { count } = await sb.from('event_checkins').select('id', { count: 'exact', head: true }).eq('reservation_id', r1)
      assertEq(count, 0, 'not checked in')
      const a = await api<Body>(`/api/events/${ev.id}/reservations/${r1}/attend`, { method: 'POST', cookie: oc, body: {} })
      assertEq([a.status, a.body.reason], [403, 'client_mode'], 'manual "present" refused too')
    })

    await step('the owner and strangers are unchanged in Client mode', async () => {
      assertEq((await api<Body>(`/api/scan/${t1}`, { cookie: customerCookie(buyer) })).body.access, 'owner', 'owner sees their ticket')
      const stranger = await makeCustomer({ suiteNo: 92, name: 'Mode Stranger' })
      assertEq((await api<Body>(`/api/scan/${t1}`, { cookie: customerCookie(stranger) })).body.access, 'none', 'stranger: neutral')
    })

    await step('"Passer en mode Pro" → the same validation works', async () => {
      assertEq((await api('/api/customer/mode', { method: 'PATCH', cookie: oc, body: { mode: 'pro' } })).status, 200, 'switched')
      assertEq((await api<Body>(`/api/scan/${t1}`, { method: 'POST', cookie: oc, body: {} })).status, 200, 'checked in')
      await api('/api/customer/mode', { method: 'PATCH', cookie: oc, body: { mode: 'client' } })
      const t2 = await ensureScanToken('reservation', await book())
      assertEq((await api<Body>(`/api/scan/${t2}`, { method: 'POST', cookie: oc, body: {} })).body.reason, 'client_mode', 'back in Client → refused again')
    })

    await step('riders: the delivery code is refused in Client mode', async () => {
      const owner = await makeCustomer({ suiteNo: 92, name: 'Mode Owner', extra: { default_mode: 'pro' } })
      const rest = await makeRestaurant({ ownerId: owner.id, label: 'scanmode_r' })
      await sb.from('restaurants').update({ riders_mode: 'app' }).eq('id', rest.id)
      const riderAcc = await makeCustomer({ suiteNo: 92, name: 'Mode Rider' })
      const { data: rider } = await sb.from('restaurant_riders').insert({ restaurant_id: rest.id, customer_id: riderAcc.id }).select('id').single()
      const o = await makeOrder(rest.id, buyer, { status: 'out_for_delivery', extra: { fulfilment: 'delivery', delivery_address: 'Rue 1', rider_id: rider!.id } })
      const rc = customerCookie(riderAcc)
      const r = await api<Body>(`/api/rider/orders/${o.id}/deliver`, { cookie: rc, body: { code: deliveryCode(o.id) } })
      assertEq([r.status, r.body.reason], [403, 'client_mode'], 'Client mode → 403')
      await api('/api/customer/mode', { method: 'PATCH', cookie: rc, body: { mode: 'pro' } })
      assertEq((await api(`/api/rider/orders/${o.id}/deliver`, { cookie: rc, body: { code: deliveryCode(o.id) } })).status, 200, 'Pro mode → delivered')
    })

    await step('admins have no mode', async () => {
      const t3 = await ensureScanToken('reservation', await book())
      assertEq((await api<Body>(`/api/scan/${t3}`, { method: 'POST', cookie: await adminCookie(), body: {} })).status, 200, 'admin validates')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
