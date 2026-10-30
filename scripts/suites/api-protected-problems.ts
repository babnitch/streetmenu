// Protected payments P1d — problems.
//
//   - the customer reports a problem (order page route, WhatsApp
//     "probleme …"): funds 'disputed', one open problem, audited; a second
//     report is refused; the code, "Reçu" and auto-release can't release it;
//   - Admin → Commandes → Problèmes lists it (admins only);
//   - the admin decides: release (→ restaurant), full refund (→ customer),
//     partial (refund X, the rest → restaurant when the refund completes);
//     a failed refund opens the problem again.
//
// 🔴 SAFETY. Refund decisions run in-process with PawaPay stubbed; the
// server only handles routes that never call PawaPay. Every phone is +999.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie, staffCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { settleDeposit } from '@/lib/payments-settle'
import { settleRefund } from '@/lib/refunds'
import { clearProtectedSettingsCache, autoReleaseDue, releaseWithCode, handoverCode, resolveProblem } from '@/lib/protectedPayments'
import { handleOrderCommand } from '@/lib/whatsapp/ordering'

const SUITE = 'api-protected-problems'

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('api.twilio.com')) return new Response(JSON.stringify({ sid: 'SM_TEST', status: 'queued' }), { status: 201 })
  if (url.includes('pawapay') && url.includes('/refunds')) return new Response(JSON.stringify({ status: 'ACCEPTED' }), { status: 200 })
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
async function heldOrder(restaurantId: string, customer: Customer, status = 'delivered'): Promise<string> {
  const d = testName(`xdep${++dep}`)
  const o = await makeOrder(restaurantId, customer, { total: 2500, extra: { order_type: 'paid_order', payment_status: 'pending', payment_id: d } })
  await settleDeposit(d, { status: 'COMPLETED', amount: '2500' }, 'webhook')
  await sb.from('orders').update({ status, delivered_at: new Date().toISOString() } as never).eq('id', o.id)
  return o.id
}
const funds = async (id: string) => (await sb.from('orders').select('funds_status').eq('id', id).single()).data?.funds_status as string
async function problemOf(orderId: string) {
  const { data } = await sb.from('order_problems').select('id, status, via, refund_id').eq('order_id', orderId).order('created_at')
  for (const p of data ?? []) track('order_problems', (p as { id: string }).id)
  return (data ?? []) as Array<{ id: string; status: string; via: string; refund_id: string | null }>
}
async function sums(orderId: string) {
  const { data } = await sb.from('money_ledger').select('party_type, bucket, delta').eq('order_id', orderId)
  const s = (b: string, p: string) => (data ?? []).filter(x => x.bucket === b && x.party_type === p).reduce((a, x) => a + Number(x.delta), 0)
  return { held: s('held', 'restaurant'), available: s('available', 'restaurant'), refunded: s('refunded', 'customer') }
}
async function refundIdOf(problemId: string): Promise<string> {
  const { data } = await sb.from('order_problems').select('refund_id').eq('id', problemId).single()
  const id = data?.refund_id as string
  track('refunds', id)
  return id
}

async function main(): Promise<void> {
  try {
    await setMaster(true)
    const buyer = await makeCustomer({ name: 't_prob_buyer' })
    const other = await makeCustomer({ name: 't_prob_other' })
    // 5 reports per customer per hour (rate limit): the refund steps use their own.
    const buyer2 = await makeCustomer({ name: 't_prob_buyer2' })
    const bc2 = customerCookie(buyer2)
    const rest = await makeRestaurant({ label: 'prot_problems', modules: PROTECTED })
    const bc = customerCookie(buyer)
    const admin = await adminCookie()
    const ADMIN = { id: '00000000-0000-0000-0000-000000000000', type: 'super_admin' }

    let first = ''
    await step('customer reports a problem: held, disputed, nothing can release it', async () => {
      first = await heldOrder(rest.id, buyer)
      assertEq((await api(`/api/orders/${first}/problem`, { method: 'POST', cookie: customerCookie(other), body: { reason: 'pas à moi' } })).status, 404, 'another customer → 404')
      assertEq((await api(`/api/orders/${first}/problem`, { method: 'POST', cookie: bc, body: { reason: '' } })).status, 400, 'empty reason → 400')
      const r = await api(`/api/orders/${first}/problem`, { method: 'POST', cookie: bc, body: { reason: 'Il manque le plantain' } })
      assertEq(r.status, 200, 'reported')
      assertEq(await funds(first), 'disputed', 'funds disputed')
      assertEq((await problemOf(first)).map(p => [p.status, p.via]), [['open', 'web']], 'one open problem (web)')
      assertEq((await api(`/api/orders/${first}/problem`, { method: 'POST', cookie: bc, body: { reason: 'encore' } })).status, 409, 'a second report → 409')
      assertEq((await autoReleaseDue(Date.now() + 48 * 3600_000, [first])).released, 0, 'auto-release stopped')
      assert(!(await releaseWithCode(first, handoverCode(first), { id: null, type: 'vendor' }, 'app')).ok, 'the code can\'t release it')
      assertEq((await api(`/api/orders/${first}/received`, { method: 'POST', cookie: bc })).status, 409, '"Reçu" can\'t release it either')
      const { count } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('target_id', first).eq('action', 'order_problem_reported')
      assertEq(count, 1, 'audited')
    })

    await step('WhatsApp "probleme …" reports the latest held order', async () => {
      const id = await heldOrder(rest.id, buyer)
      await handleOrderCommand(`whatsapp:${buyer.phone}`, buyer.phone, 'probleme pas reçu', { id: buyer.id, name: buyer.name, phone: buyer.phone, city: null, preferred_language: 'fr' } as never, 'probleme pas reçu')
      assertEq((await problemOf(id)).map(p => [p.status, p.via]), [['open', 'whatsapp']], 'open problem via WhatsApp')
      assertEq(await funds(id), 'disputed', 'disputed')
    })

    await step('Admin → Problèmes: listed for admins only; "release" pays the restaurant', async () => {
      const mod = staffCookie({ id: '00000000-0000-0000-0000-000000000000', email: 'm@test.invalid', name: 'Mod', role: 'moderator' })
      assertEq((await api('/api/admin/problems', { cookie: mod })).status, 401, 'moderator → 401')
      const list = await api<{ problems: Array<{ id: string; order_id: string; held: number; status: string }> }>('/api/admin/problems', { cookie: admin })
      const p = (list.body.problems ?? []).find(x => x.order_id === first)
      assert(!!p && p.status === 'open' && p.held === 2500, 'listed, open, 2500 held')
      const r = await api(`/api/admin/problems/${p?.id}`, { method: 'POST', cookie: admin, body: { decision: 'release', note: 'livreur confirme' } })
      assertEq(r.status, 200, 'release decided')
      assertEq(await funds(first), 'released', 'released')
      assertEq((await problemOf(first))[0].status, 'released', 'problem closed: released')
      assertEq((await sums(first)).available, 2500, 'restaurant available 2500')
      assertEq((await api(`/api/admin/problems/${p?.id}`, { method: 'POST', cookie: admin, body: { decision: 'refund' } })).status, 409, 'deciding twice → 409')
    })

    await step('full refund: all back to the customer once the refund completes', async () => {
      const id = await heldOrder(rest.id, buyer2)
      await api(`/api/orders/${id}/problem`, { method: 'POST', cookie: bc2, body: { reason: 'Commande jamais reçue' } })
      const [p] = await problemOf(id)
      const r = await resolveProblem(p.id, { kind: 'refund' }, ADMIN, 'jamais livrée')
      assert(r.ok, 'refund decided')
      assertEq([await funds(id), (await problemOf(id))[0].status], ['refunding', 'refunded'], 'refunding, problem refunded')
      await settleRefund(await refundIdOf(p.id), { status: 'COMPLETED' }, 'webhook')
      assertEq(await funds(id), 'refunded', 'funds refunded')
      assertEq(await sums(id), { held: 0, available: 0, refunded: 2500 }, 'ledger: customer 2500')
    })

    await step('partial: refund 1000, the rest goes to the restaurant', async () => {
      const id = await heldOrder(rest.id, buyer2)
      await api(`/api/orders/${id}/problem`, { method: 'POST', cookie: bc2, body: { reason: 'Il manque une boisson' } })
      const [p] = await problemOf(id)
      assert(!(await resolveProblem(p.id, { kind: 'partial', amount: 2500 }, ADMIN, '')).ok, 'partial = everything → refused')
      assert((await resolveProblem(p.id, { kind: 'partial', amount: 1000 }, ADMIN, 'boisson')).ok, 'partial decided')
      await settleRefund(await refundIdOf(p.id), { status: 'COMPLETED' }, 'webhook')
      assertEq(await funds(id), 'released', 'the rest released')
      assertEq(await sums(id), { held: 0, available: 1500, refunded: 1000 }, 'customer 1000, restaurant 1500')
    })

    await step('a decided refund that fails opens the problem again', async () => {
      const id = await heldOrder(rest.id, buyer2)
      await api(`/api/orders/${id}/problem`, { method: 'POST', cookie: bc2, body: { reason: 'Froid' } })
      const [p] = await problemOf(id)
      await resolveProblem(p.id, { kind: 'refund' }, ADMIN, '')
      await settleRefund(await refundIdOf(p.id), { status: 'FAILED', failureReason: 'test' }, 'webhook')
      assertEq([(await problemOf(id))[0].status, await funds(id)], ['open', 'disputed'], 'open again, money held')
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
