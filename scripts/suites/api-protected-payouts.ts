// Protected payments P2 — balances, "À payer", daily payouts, payout number.
//
//   - "Mon argent": owner + manager see held / available / in transit /
//     paid out; staff and strangers can't;
//   - Admin "À payer" lists the available balance; "Payer" sends all of it:
//     available → in transit, one payout per pro per day; COMPLETED (PawaPay
//     callback) → paid out, once; FAILED or refused at once → back to
//     available, and a new payout the same day is allowed;
//   - a new payout number waits for an admin's confirmation (owner only);
//   - the ticket commission uses the shared helper (same formula as before).
//
// 🔴 SAFETY. "Payer" runs in-process with PawaPay stubbed (never reached).
// The payout number is PawaPay's SANDBOX test MSISDN; every other phone is
// +999. All ledger lines are is_test (test city + sandbox).

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, addTeamMember, PAWAPAY_SANDBOX_COMPLETED_CMR } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { settleDeposit } from '@/lib/payments-settle'
import { clearProtectedSettingsCache, releaseOrderFunds } from '@/lib/protectedPayments'
import { payRestaurant, settleProPayout, restaurantBalances } from '@/lib/proPayouts'
import { eventCommissionRate, ticketCommission } from '@/lib/commission'

const SUITE = 'api-protected-payouts'

let payoutAnswer: 'ACCEPTED' | 'REJECTED' = 'ACCEPTED'
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('api.twilio.com')) return new Response(JSON.stringify({ sid: 'SM_TEST', status: 'queued' }), { status: 201 })
  if (url.includes('pawapay') && url.endsWith('/payouts')) {
    return new Response(JSON.stringify(payoutAnswer === 'ACCEPTED' ? { status: 'ACCEPTED' } : { status: 'REJECTED', rejectionReason: { rejectionMessage: 'test refusal' } }), { status: 200 })
  }
  if (url.includes('pawapay')) return new Response('blocked by test', { status: 599 })
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

const PROTECTED = ['orders', 'payment', 'payments_protected']
const PAYOUT_PHONE = `+${PAWAPAY_SANDBOX_COMPLETED_CMR}`
let dep = 0

async function setMaster(on: boolean): Promise<void> {
  const { error } = await sb.from('platform_settings').upsert({ key: 'test_payments_protected_master', value: on } as never, { onConflict: 'key' })
  if (error) throw new Error(`master: ${error.message}`)
  clearProtectedSettingsCache()
}

type Customer = Awaited<ReturnType<typeof makeCustomer>>
async function releasedOrder(restaurantId: string, customer: Customer, total: number): Promise<string> {
  const d = testName(`ydep${++dep}`)
  const o = await makeOrder(restaurantId, customer, { total, status: 'delivered', extra: { order_type: 'paid_order', payment_status: 'pending', payment_id: d } })
  await settleDeposit(d, { status: 'COMPLETED', amount: String(total) }, 'webhook')
  const r = await releaseOrderFunds(o.id, 'customer', null)
  if (!r.ok) throw new Error(`release: ${r.error}`)
  return o.id
}
async function payoutsOf(restaurantId: string) {
  const { data } = await sb.from('pro_payouts').select('id, status, amount, is_test').eq('party_id', restaurantId).order('created_at')
  for (const p of data ?? []) track('pro_payouts', (p as { id: string }).id)
  return (data ?? []) as Array<{ id: string; status: string; amount: number; is_test: boolean }>
}
const ADMIN = { id: '00000000-0000-0000-0000-000000000000', type: 'super_admin' }

async function main(): Promise<void> {
  try {
    await setMaster(true)
    const owner = await makeCustomer({ name: 't_pay_owner' })
    const manager = await makeCustomer({ name: 't_pay_manager' })
    const staff = await makeCustomer({ name: 't_pay_staff' })
    const buyer = await makeCustomer({ name: 't_pay_buyer' })
    const rest = await makeRestaurant({ label: 'prot_payout', ownerId: owner.id, modules: PROTECTED, extra: { payout_phone: PAYOUT_PHONE } })
    track('restaurant_team', await addTeamMember(rest.id, manager.id, 'manager'))
    track('restaurant_team', await addTeamMember(rest.id, staff.id, 'staff'))
    const admin = await adminCookie()

    await step('"Mon argent": owner + manager see the balances; staff can\'t', async () => {
      await releasedOrder(rest.id, buyer, 2500)
      await releasedOrder(rest.id, buyer, 2500)
      const m = await api<{ balances: Record<string, number>; sandbox: boolean; payout_phone: string }>(`/api/restaurants/${rest.id}/money`, { cookie: customerCookie(owner) })
      assertEq(m.status, 200, 'owner → 200')
      assertEq([m.body.balances?.held, m.body.balances?.available, m.body.sandbox, m.body.payout_phone], [0, 5000, true, PAYOUT_PHONE], 'available 5000 (sandbox), payout number')
      assertEq((await api(`/api/restaurants/${rest.id}/money`, { cookie: customerCookie(manager) })).status, 200, 'manager → 200')
      assertEq((await api(`/api/restaurants/${rest.id}/money`, { cookie: customerCookie(staff) })).status, 403, 'staff → 403')
    })

    await step('"À payer" lists it; "Payer" sends it all, once a day; COMPLETED → paid out', async () => {
      const list = await api<{ rows: Array<{ restaurant_id: string; available: number }> }>('/api/admin/payouts', { cookie: admin })
      assertEq((list.body.rows ?? []).find(r => r.restaurant_id === rest.id)?.available, 5000, 'listed: 5000 to pay')
      const r = await payRestaurant(rest.id, ADMIN)
      assert(r.ok && r.amount === 5000, `paid 5000 (${r.ok ? r.status : r.error})`)
      assertEq(await restaurantBalances(rest.id), { held: 0, available: 0, in_transit: 5000, paid_out: 0 }, 'available → in transit')
      const again = await payRestaurant(rest.id, ADMIN)
      assert(!again.ok, 'a second payout the same day is refused')
      const [p] = await payoutsOf(rest.id)
      assertEq([p.status, p.amount, p.is_test], ['pending', 5000, true], 'one pending payout, test money')
      const cb = await api<{ pro_payout?: string }>('/api/payments/webhook', { body: { payoutId: p.id, status: 'COMPLETED', amount: '5000', currency: 'XAF' } })
      assertEq(cb.body.pro_payout, 'completed', 'PawaPay callback → completed')
      assertEq(await restaurantBalances(rest.id), { held: 0, available: 0, in_transit: 0, paid_out: 5000 }, 'paid out 5000')
      assertEq(await settleProPayout(p.id, 'COMPLETED', null), 'already_settled', 'a second callback changes nothing')
    })

    await step('failed or refused payout → back to available; a new one the same day is allowed', async () => {
      const owner2 = await makeCustomer({ name: 't_pay_owner2' })
      const rest2 = await makeRestaurant({ label: 'prot_payout2', ownerId: owner2.id, modules: PROTECTED, extra: { payout_phone: PAYOUT_PHONE } })
      await releasedOrder(rest2.id, buyer, 3000)
      const a = await payRestaurant(rest2.id, ADMIN)
      assert(a.ok, 'payout started')
      if (a.ok) assertEq(await settleProPayout(a.payoutId, 'FAILED', 'test'), 'failed', 'failed')
      assertEq((await restaurantBalances(rest2.id)).available, 3000, 'back to available')
      payoutAnswer = 'REJECTED'
      const b = await payRestaurant(rest2.id, ADMIN)
      payoutAnswer = 'ACCEPTED'
      assert(!b.ok, 'refused at once by PawaPay → error')
      assertEq((await restaurantBalances(rest2.id)).available, 3000, 'still available')
      const c = await payRestaurant(rest2.id, ADMIN)
      assert(c.ok, 'a third try the same day is allowed (the others failed)')
      assertEq((await payoutsOf(rest2.id)).map(x => x.status), ['failed', 'failed', 'pending'], 'two failed, one pending')
    })

    await step('payout number: the owner asks, an admin confirms', async () => {
      const newPhone = '+237670009999'
      assertEq((await api(`/api/restaurants/${rest.id}/payout-phone`, { method: 'POST', cookie: customerCookie(manager), body: { phone: newPhone } })).status, 403, 'manager → 403')
      assertEq((await api(`/api/restaurants/${rest.id}/payout-phone`, { method: 'POST', cookie: customerCookie(owner), body: { phone: '12' } })).status, 400, 'bad number → 400')
      assertEq((await api(`/api/restaurants/${rest.id}/payout-phone`, { method: 'POST', cookie: customerCookie(owner), body: { phone: newPhone } })).status, 200, 'owner asks')
      const { data: before } = await sb.from('restaurants').select('payout_phone, payout_phone_pending').eq('id', rest.id).single()
      assertEq([before?.payout_phone, before?.payout_phone_pending], [PAYOUT_PHONE, newPhone], 'still paid on the old number until confirmed')
      assertEq((await api('/api/admin/payouts/phone', { cookie: admin, body: { restaurant_id: rest.id, approve: true } })).status, 200, 'admin confirms')
      const { data: after } = await sb.from('restaurants').select('payout_phone, payout_phone_pending').eq('id', rest.id).single()
      assertEq([after?.payout_phone, after?.payout_phone_pending], [newPhone, null], 'new number in use')
      assertEq((await api('/api/admin/payouts/phone', { cookie: admin, body: { restaurant_id: rest.id, approve: true } })).status, 409, 'nothing left to confirm → 409')
    })

    await step('ticket commission: one helper, same formula as before', async () => {
      assertEq([eventCommissionRate(null), eventCommissionRate(0), eventCommissionRate(0.05)], [0.1, 0.1, 0.05], 'rate: 10 % default, 0 → 10 %')
      assertEq([ticketCommission(3000, 0.1), ticketCommission(0, 0.1), ticketCommission(2999, 0.1)], [300, 0, 300], 'Math.round(total × rate)')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await setMaster(false).catch(() => null)
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }
  finish(SUITE)
}

void main()
