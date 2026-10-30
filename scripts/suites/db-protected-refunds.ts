// Protected payments P1c — automatic refunds and the ledger on completion.
//
//   - the restaurant refuses / cancels (WhatsApp "annuler XXXX") → full
//     refund started, funds 'refunding' (the code can't release it any
//     more), the customer is told; refund COMPLETED → ledger held → customer,
//     funds 'refunded', order cancelled;
//   - accept timeout: still pending after the deadline → cancelled +
//     refunded; an accepted order is never touched;
//   - PawaPay refuses the refund, or it fails later → 'disputed' (money
//     still held, admins alerted);
//   - partial refund: pay 5000, refund 1000 → 'disputed'; admin releases the
//     rest → restaurant available 4000 minus commission.
//
// 🔴 SAFETY. In-process, fetch stubbed: PawaPay answers are played here
// (never reached), Twilio sends are counted. Every phone is +999.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { makeCustomer, makeRestaurant, makeOrder } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { settleDeposit } from '@/lib/payments-settle'
import { settleRefund, startRefund } from '@/lib/refunds'
import {
  clearProtectedSettingsCache, acceptTimeoutDue, releaseWithCode, releaseOrderFunds, handoverCode,
} from '@/lib/protectedPayments'
import { orderCommission } from '@/lib/commission'
import { handleVendorOrderAction } from '@/lib/whatsapp/ordering'

const SUITE = 'db-protected-refunds'

let refundAnswer: 'ACCEPTED' | 'REJECTED' = 'ACCEPTED'
const sends: Array<{ to: string; body: string }> = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('api.twilio.com')) {
    const p = new URLSearchParams(String(init?.body ?? ''))
    sends.push({ to: p.get('To') ?? '', body: p.get('Body') ?? '' })
    return new Response(JSON.stringify({ sid: 'SM_TEST', status: 'queued' }), { status: 201 })
  }
  if (url.includes('pawapay') && url.includes('/refunds')) {
    return new Response(JSON.stringify(refundAnswer === 'ACCEPTED'
      ? { status: 'ACCEPTED' } : { status: 'REJECTED', rejectionReason: { rejectionMessage: 'test refusal' } }), { status: 200 })
  }
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
async function heldOrder(restaurantId: string, customer: Customer, total = 2500, status = 'pending'): Promise<string> {
  const d = testName(`fdep${++dep}`)
  const o = await makeOrder(restaurantId, customer, { total, extra: { order_type: 'paid_order', payment_status: 'pending', payment_id: d } })
  await settleDeposit(d, { status: 'COMPLETED', amount: String(total) }, 'webhook')
  if (status !== 'pending') await sb.from('orders').update({ status } as never).eq('id', o.id)
  return o.id
}

async function row(id: string) {
  const { data } = await sb.from('orders').select('status, funds_status, refund_status').eq('id', id).single()
  return data as { status: string; funds_status: string; refund_status: string }
}
async function refundsOf(id: string) {
  const { data } = await sb.from('refunds').select('id, amount, status, cancel_after').eq('order_id', id).order('created_at')
  for (const r of data ?? []) track('refunds', (r as { id: string }).id)
  return (data ?? []) as Array<{ id: string; amount: number; status: string; cancel_after: boolean }>
}
async function ledger(id: string) {
  const { data } = await sb.from('money_ledger').select('party_type, bucket, delta, is_test').eq('order_id', id).order('created_at').order('line')
  return (data ?? []) as Array<{ party_type: string; bucket: string; delta: number; is_test: boolean }>
}
const code4 = (id: string) => id.replace(/-/g, '').slice(-4)

async function main(): Promise<void> {
  try {
    await setMaster(true)
    const buyer = await makeCustomer({ name: 't_prot_refund_buyer' })
    const rest = await makeRestaurant({ label: 'prot_refund', modules: PROTECTED })

    await step('restaurant refuses (WhatsApp) → refund started, code no longer releases', async () => {
      const id = await heldOrder(rest.id, buyer)
      const before = sends.length
      await handleVendorOrderAction(rest.whatsapp, `annuler ${code4(id)}`, { id: rest.id, name: rest.name })
      const r = await row(id)
      assertEq([r.status, r.funds_status], ['cancelled', 'refunding'], 'cancelled, funds refunding')
      const rf = await refundsOf(id)
      assertEq(rf.map(x => [x.amount, x.status, x.cancel_after]), [[2500, 'pending', true]], 'one full refund started')
      assert(sends.slice(before).some(m => m.to === `whatsapp:${buyer.phone}` && /Nous vous remboursons|We are refunding/.test(m.body)), 'customer told')
      const c = await releaseWithCode(id, handoverCode(id), { id: null, type: 'vendor' }, 'app')
      assert(!c.ok, 'the code can\'t release a refunding order')

      assertEq((await settleRefund(rf[0].id, { status: 'COMPLETED' }, 'webhook')).action, 'completed', 'refund completed')
      assertEq((await row(id)).funds_status, 'refunded', 'funds refunded')
      assertEq((await ledger(id)).map(l => [l.party_type, l.bucket, l.delta]),
        [['restaurant', 'held', 2500], ['restaurant', 'held', -2500], ['customer', 'refunded', 2500]], 'ledger: held → customer')
      assert((await ledger(id)).every(l => l.is_test), 'all test lines')
      assertEq((await settleRefund(rf[0].id, { status: 'COMPLETED' }, 'reconcile')).action, 'already_settled', 'a second callback changes nothing')
      assertEq((await ledger(id)).length, 3, 'still 3 lines')
    })

    await step('accept timeout: pending after the deadline → cancelled + refunded; accepted untouched', async () => {
      const late = await heldOrder(rest.id, buyer)
      const accepted = await heldOrder(rest.id, buyer, 2500, 'confirmed')
      const past = new Date(Date.now() - 60_000).toISOString()
      await sb.from('orders').update({ accept_deadline: past } as never).in('id', [late, accepted])
      const out = await acceptTimeoutDue(Date.now(), [late, accepted])
      assertEq(out, { checked: 1, cancelled: 1 }, 'one order timed out')
      assertEq([(await row(late)).status, (await row(late)).funds_status], ['cancelled', 'refunding'], 'cancelled, refund running')
      assertEq((await refundsOf(late)).length, 1, 'refund started')
      assertEq([(await row(accepted)).status, (await row(accepted)).funds_status], ['confirmed', 'held'], 'the accepted order is untouched')
      const { count } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('target_id', late).eq('action', 'order_cancelled')
      assertEq(count, 1, 'cancellation audited')
    })

    await step('PawaPay refuses the refund, or it fails later → disputed, still held', async () => {
      refundAnswer = 'REJECTED'
      const a = await heldOrder(rest.id, buyer)
      await handleVendorOrderAction(rest.whatsapp, `annuler ${code4(a)}`, { id: rest.id, name: rest.name })
      refundAnswer = 'ACCEPTED'
      await refundsOf(a)
      assertEq((await row(a)).funds_status, 'disputed', 'refused → disputed')
      const { count } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('target_id', a).eq('action', 'funds_refund_start_failed')
      assertEq(count, 1, 'audited')
      assertEq((await ledger(a)).map(l => l.delta), [2500], 'money still held in the ledger')

      const b = await heldOrder(rest.id, buyer)
      await handleVendorOrderAction(rest.whatsapp, `annuler ${code4(b)}`, { id: rest.id, name: rest.name })
      const rf = await refundsOf(b)
      await settleRefund(rf[0].id, { status: 'FAILED', failureReason: 'test' }, 'webhook')
      assertEq((await row(b)).funds_status, 'disputed', 'failed later → disputed')
      assertEq((await ledger(b)).map(l => l.delta), [2500], 'still held')
    })

    await step('partial refund: pay 5000, refund 1000 → disputed; admin releases 4000 minus commission', async () => {
      const id = await heldOrder(rest.id, buyer, 5000, 'delivered')
      const s = await startRefund({ kind: 'order', targetId: id, amount: 1000, reason: 'test: un plat manquant', cancelAfter: false, adminId: null, adminRole: 'admin' })
      assert(s.ok, `partial refund started (${s.ok ? '' : s.error})`)
      await refundsOf(id)
      assertEq((await row(id)).funds_status, 'refunding', 'refunding while it runs')
      if (s.ok) await settleRefund(s.refund.id, { status: 'COMPLETED' }, 'webhook')
      assertEq((await row(id)).funds_status, 'disputed', 'partial → disputed (not stuck in refunding)')
      assertEq((await releaseOrderFunds(id, 'customer', null)).ok, false, 'only an admin releases a disputed order')
      const r = await releaseOrderFunds(id, 'admin', null)
      const expected = 4000 - orderCommission(4000, 0)
      assert(r.ok && r.amount === expected, `admin released ${r.ok ? r.amount : r.error}`)
      const l = await ledger(id)
      const sum = (b: string, p = 'restaurant') => l.filter(x => x.bucket === b && x.party_type === p).reduce((a, x) => a + x.delta, 0)
      assertEq([sum('held'), sum('available'), sum('refunded', 'customer')], [0, expected, 1000], 'held 0, available 4000, customer 1000')
      assertEq(orderCommission(4000, 5), 200, 'commission helper: 5 % of 4000 = 200')
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
