// Protected payments P1b — releasing held money, through the real routes.
//
//   - Valider → "En attente du code": the team sees held orders; a stranger
//     can't. The code typed for THAT order releases the money; a wrong code
//     counts a try; at the max the order is locked (even the right code then
//     waits for an admin).
//   - WhatsApp "CODE 1234" (one order waiting) releases it.
//   - Customer "Reçu" (pickup) releases it; a rider hand-over too.
//   - "Livrée" without a code: the customer is told (reply "probleme" within
//     N h), the money stays held, and is released automatically after N h —
//     unless a problem is open.
//
// 🔴 SAFETY. Payments are settled in-process (no PawaPay call; fetch stubbed
// for PawaPay and Twilio here). The server's own sends go to +999 numbers
// only (test guard). All ledger lines are is_test (+999 / test city / sandbox).

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { settleDeposit } from '@/lib/payments-settle'
import { clearProtectedSettingsCache, handoverCode, autoReleaseDue } from '@/lib/protectedPayments'
import { markOrderDelivered } from '@/lib/orderDelivery'
import { handleVendorOrderAction } from '@/lib/whatsapp/ordering'

const SUITE = 'api-protected-release'

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('api.twilio.com')) return new Response(JSON.stringify({ sid: 'SM_TEST', status: 'queued' }), { status: 201 })
  if (url.includes('pawapay')) return new Response('blocked by test', { status: 599 })
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

const PROTECTED = ['orders', 'payment', 'payments_protected']
let dep = 0

async function setMaster(on: boolean): Promise<void> {
  const { error } = await sb.from('platform_settings').upsert({ key: 'test_payments_protected_master', value: on } as never, { onConflict: 'key' })
  if (error) throw new Error(`master: ${error.message}`)
  clearProtectedSettingsCache()
}

type Customer = Awaited<ReturnType<typeof makeCustomer>>
async function heldOrder(restaurantId: string, customer: Customer, status = 'ready', extra: Record<string, unknown> = {}): Promise<string> {
  const d = testName(`rdep${++dep}`)
  const o = await makeOrder(restaurantId, customer, { total: 2500, extra: { order_type: 'paid_order', payment_status: 'pending', payment_id: d, ...extra } })
  await settleDeposit(d, { status: 'COMPLETED', amount: '2500' }, 'webhook')
  await sb.from('orders').update({ status } as never).eq('id', o.id)
  const { data } = await sb.from('orders').select('funds_status').eq('id', o.id).single()
  if (data?.funds_status !== 'held') throw new Error(`order not held (${data?.funds_status})`)
  return o.id
}

async function funds(id: string) {
  const { data } = await sb.from('orders').select('funds_status, funds_released_by, status, delivered_confirmed_by, release_attempts, release_locked_at').eq('id', id).single()
  return data as { funds_status: string; funds_released_by: string | null; status: string; delivered_confirmed_by: string | null; release_attempts: number; release_locked_at: string | null }
}

async function available(orderId: string): Promise<number> {
  const { data } = await sb.from('money_ledger').select('delta').eq('order_id', orderId).eq('bucket', 'available')
  return (data ?? []).reduce((a, r) => a + Number((r as { delta: number }).delta), 0)
}

const wrongOf = (code: string) => String((Number(code) + 1) % 10000).padStart(4, '0')

async function main(): Promise<void> {
  try {
    await setMaster(true)
    const owner = await makeCustomer({ name: 't_prot_owner', extra: { default_mode: 'pro' } })
    const buyer = await makeCustomer({ name: 't_prot_buyer' })
    const stranger = await makeCustomer({ name: 't_prot_stranger' })
    const rest = await makeRestaurant({ label: 'prot_release', ownerId: owner.id, modules: PROTECTED })
    const oc = customerCookie(owner), bc = customerCookie(buyer)
    const release = (id: string, code: string, cookie = oc) =>
      api<{ ok?: boolean; amount?: number; tries_left?: number; reason?: string }>(`/api/orders/${id}/release-code`, { method: 'POST', cookie, body: { code } })

    await step('Valider: the team sees orders waiting for the code; a stranger does not', async () => {
      const id = await heldOrder(rest.id, buyer)
      const list = await api<{ orders: Array<{ id: string }> }>(`/api/restaurants/${rest.id}/awaiting-code`, { cookie: oc })
      assert((list.body.orders ?? []).some(o => o.id === id), 'held order listed for the owner')
      assertEq((await api(`/api/restaurants/${rest.id}/awaiting-code`, { cookie: customerCookie(stranger) })).status, 403, 'stranger → 403')
      assertEq((await release(id, handoverCode(id), customerCookie(stranger))).status, 404, 'stranger can\'t type a code')
    })

    await step('code for THIS order: wrong → a try counted; right → handed over + released', async () => {
      const id = await heldOrder(rest.id, buyer)
      const code = handoverCode(id)
      const w = await release(id, wrongOf(code))
      assertEq([w.status, w.body.reason, w.body.tries_left], [400, 'wrong_code', 4], 'wrong code → 400, 4 tries left')
      const ok = await release(id, code)
      assertEq([ok.status, ok.body.amount], [200, 2500], 'right code → released 2500 (commission 0)')
      const f = await funds(id)
      assertEq([f.funds_status, f.funds_released_by, f.status, f.delivered_confirmed_by], ['released', 'code', 'delivered', 'restaurant_code'], 'released by code, delivered')
      assertEq(await available(id), 2500, 'restaurant available +2500')
      assertEq((await release(id, code)).status, 409, 'twice → 409, released once')
    })

    await step('lockout: 5 wrong codes lock the order, even the right one then waits', async () => {
      const id = await heldOrder(rest.id, buyer)
      const code = handoverCode(id)
      const statuses: number[] = []
      for (let i = 0; i < 5; i++) statuses.push((await release(id, wrongOf(code))).status)
      assertEq(statuses, [400, 400, 400, 400, 423], 'the 5th wrong code locks it')
      const f = await funds(id)
      assert(f.release_attempts === 5 && !!f.release_locked_at, 'tries + lock stored')
      assertEq((await release(id, code)).status, 423, 'right code after the lock → 423')
      assertEq((await funds(id)).funds_status, 'held', 'money still held')
      const { count } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('target_id', id).eq('action', 'release_code_locked')
      assertEq(count, 1, 'lock audited (admins alerted)')
    })

    await step('"Livrée" without code: customer told, held, auto-released after the delay', async () => {
      const id = await heldOrder(rest.id, buyer)
      const r = await api(`/api/orders/${id}/status`, { method: 'POST', cookie: oc, body: { status: 'delivered' } })
      assertEq(r.status, 200, 'marked delivered from the dashboard')
      const { data: logs } = await sb.from('message_log').select('body').eq('related_id', id).like('body', '%probleme%')
      assert((logs ?? []).length === 1 && /marquée récupérée|marked collected/.test(String(logs?.[0]?.body)), 'customer told: reply "probleme" within N h')
      assertEq((await funds(id)).funds_status, 'held', 'money still held')
      assertEq((await autoReleaseDue(Date.now(), [id])).released, 0, 'not before the delay')
      assertEq((await autoReleaseDue(Date.now() + 25 * 3600_000, [id])).released, 1, 'released after the delay')
      const f = await funds(id)
      assertEq([f.funds_status, f.funds_released_by], ['released', 'auto'], 'released by auto')
    })

    await step('an open problem stops the auto-release', async () => {
      const id = await heldOrder(rest.id, buyer)
      await api(`/api/orders/${id}/status`, { method: 'POST', cookie: oc, body: { status: 'delivered' } })
      const { data: p, error } = await sb.from('order_problems').insert({ order_id: id, reason: 'test: manque un plat' } as never).select('id').single()
      assert(!error, `problem row (${error?.message ?? ''})`)
      track('order_problems', (p as { id: string } | null)?.id)
      assertEq((await autoReleaseDue(Date.now() + 25 * 3600_000, [id])).released, 0, 'not released')
      assertEq((await funds(id)).funds_status, 'held', 'still held')
    })

    await step('customer "Reçu" (pickup) and the rider release it', async () => {
      const a = await heldOrder(rest.id, buyer)
      const r = await api<{ released?: boolean }>(`/api/orders/${a}/received`, { method: 'POST', cookie: bc })
      assertEq([r.status, r.body.released], [200, true], 'Reçu → 200, released')
      const fa = await funds(a)
      assertEq([fa.funds_status, fa.funds_released_by, fa.delivered_confirmed_by], ['released', 'customer', 'customer'], 'released by the customer')
      const b = await heldOrder(rest.id, buyer, 'out_for_delivery', { fulfilment: 'delivery', delivery_address: 'Rue des Tests, Bastos', delivery_fee: 0 })
      const m = await markOrderDelivered(b, 'rider', { id: null, type: 'customer' }, { notify: 'none' })
      assert(m.ok, 'rider hand-over')
      assertEq((await funds(b)).funds_released_by, 'rider', 'released by the rider')
    })

    await step('WhatsApp "CODE 1234": one order waiting → released; none → told so', async () => {
      const owner2 = await makeCustomer({ name: 't_prot_owner2' })
      const rest2 = await makeRestaurant({ label: 'prot_wa', ownerId: owner2.id, modules: PROTECTED })
      const id = await heldOrder(rest2.id, buyer)
      await handleVendorOrderAction(rest2.whatsapp, `CODE ${handoverCode(id)}`, { id: rest2.id, name: rest2.name })
      const f = await funds(id)
      assertEq([f.funds_status, f.funds_released_by], ['released', 'code'], 'released by code over WhatsApp')
      const resp = await handleVendorOrderAction(rest2.whatsapp, 'CODE 1234', { id: rest2.id, name: rest2.name })
      assert(!!resp, 'answered when no order is waiting')
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
