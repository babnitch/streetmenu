// Prompt R — refunds (R2), PawaPay config (R1), payout test (R3).
// SANDBOX ONLY: the dev server's PawaPay is the sandbox. PawaPay's outcome
// is played by posting callbacks to /api/payments/refund-webhook (signature
// check is log-only outside production). Every phone is +999.
//
// Checked: super admin only; reason + amount checks; the total refunded
// never exceeds what was paid; one refund in progress per payment;
// callbacks settle once (a duplicate is a no-op); a partial refund →
// 'partial'; the rest → 'refunded', payment 'refunded', order cancelled; a
// ticket refund with "cancel" cancels the booking; one WhatsApp per
// completed refund; audit rows.

import { randomUUID } from 'crypto'
import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, staffCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, makeEvent } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-refunds-r'

async function startPending(kind: 'order' | 'reservation', target: string, amount: number, cancel = false): Promise<{ id?: string; error?: string }> {
  const id = randomUUID()
  const { data, error } = await sb.rpc('start_refund', { p_id: id, p_kind: kind, p_target: target, p_amount: amount, p_reason: 'test', p_cancel: cancel, p_admin: null })
  if (error) return { error: error.message }
  track('refunds', id)
  return { id: (data as { id: string }).id }
}
const callback = (refundId: string, status: string) =>
  api<{ action?: string }>('/api/payments/refund-webhook', { body: { refundId, status, failureReason: status === 'FAILED' ? { failureCode: 'X', failureMessage: 'test failure' } : undefined } })
async function messagesTo(phone: string): Promise<number> {
  const { count } = await sb.from('message_log').select('id', { count: 'exact', head: true }).like('to_number', `%${phone.replace('+', '')}%`)
  return count ?? 0
}

async function main(): Promise<void> {
  try {
    const superAdmin = await adminCookie()
    const admin = staffCookie({ id: randomUUID(), email: 'a@test.invalid', name: 'Admin', role: 'admin' })
    const buyer = await makeCustomer({ suiteNo: 98, name: 'Refund Buyer' })
    const rest = await makeRestaurant({ label: 'refund_r' })
    const order = await makeOrder(rest.id, buyer, { total: 2000, status: 'confirmed', extra: { payment_status: 'paid', payment_id: randomUUID(), payment_amount: 2000, order_type: 'paid_order' } })
    track('orders', order.id)

    await step('who, what: super admin only, reason and amount checked', async () => {
      assertEq((await api(`/api/admin/refunds?kind=order&id=${order.id}`, { cookie: admin })).status, 403, 'admin (not super) → 403')
      assertEq((await api('/api/admin/refunds', { cookie: admin, body: { kind: 'order', id: order.id, amount: 100, reason: 'test' } })).status, 403, 'admin POST → 403')
      const info = await api<{ paid: number; refundable: number }>(`/api/admin/refunds?kind=order&id=${order.id}`, { cookie: superAdmin })
      assertEq([info.status, info.body.paid, info.body.refundable], [200, 2000, 2000], 'paid 2000, all refundable')
      const noReason = await api<{ field?: string }>('/api/admin/refunds', { cookie: superAdmin, body: { kind: 'order', id: order.id, amount: 100, reason: '' } })
      assertEq([noReason.status, noReason.body.field], [400, 'reason'], 'no reason → 400')
      assertEq((await api('/api/admin/refunds', { cookie: superAdmin, body: { kind: 'order', id: order.id, amount: 10.5, reason: 'x test' } })).status, 400, 'decimals → 400')
      const over = await api<{ reason?: string }>('/api/admin/refunds', { cookie: superAdmin, body: { kind: 'order', id: order.id, amount: 2001, reason: 'too much' } })
      assertEq([over.status, over.body.reason], [409, 'over_amount'], 'more than paid → 409')
      const unpaid = await makeOrder(rest.id, buyer, { total: 1000 })
      track('orders', unpaid.id)
      const np = await api<{ reason?: string }>('/api/admin/refunds', { cookie: superAdmin, body: { kind: 'order', id: unpaid.id, amount: 100, reason: 'not paid' } })
      assertEq([np.status, np.body.reason], [409, 'not_paid'], 'unpaid order → 409')
    })

    await step('partial refund: one in progress at a time, callback settles once', async () => {
      const p = await startPending('order', order.id, 500)
      assert(!!p.id, `pending refund created (${p.error ?? ''})`)
      const busy = await api<{ reason?: string }>('/api/admin/refunds', { cookie: superAdmin, body: { kind: 'order', id: order.id, amount: 100, reason: 'second one' } })
      assertEq([busy.status, busy.body.reason], [409, 'refund_in_progress'], 'second refund while one is pending → 409')
      const { data: mid } = await sb.from('orders').select('refund_status').eq('id', order.id).single()
      assertEq(mid!.refund_status, 'pending', 'order shows refund pending')
      const before = await messagesTo(buyer.phone)
      const cb = await callback(p.id!, 'COMPLETED')
      assertEq([cb.status, cb.body.action], [200, 'completed'], 'COMPLETED callback → completed')
      assertEq((await callback(p.id!, 'COMPLETED')).body.action, 'already_settled', 'duplicate callback → no-op')
      const { data: o } = await sb.from('orders').select('refund_status, refunded_amount, payment_status, status').eq('id', order.id).single()
      assertEq(o, { refund_status: 'partial', refunded_amount: 500, payment_status: 'paid', status: 'confirmed' }, 'partial: 500 refunded, order still on')
      assertEq(await messagesTo(buyer.phone) - before, 1, 'one WhatsApp to the customer')
      const { data: audit } = await sb.from('audit_log').select('action').eq('target_id', order.id)
      assert((audit ?? []).some(a => a.action === 'refund_completed'), 'audited')
    })

    await step('a failed refund changes nothing; the rest → refunded + order cancelled', async () => {
      const f = await startPending('order', order.id, 1500)
      assertEq((await callback(f.id!, 'FAILED')).body.action, 'failed', 'FAILED callback → failed')
      const { data: o1 } = await sb.from('orders').select('refund_status, refunded_amount').eq('id', order.id).single()
      assertEq(o1, { refund_status: 'partial', refunded_amount: 500 }, 'back to partial, nothing added')
      const { data: fr } = await sb.from('refunds').select('status, failure_reason').eq('id', f.id!).single()
      assertEq(fr, { status: 'failed', failure_reason: 'test failure' }, 'failure kept')

      const over = await startPending('order', order.id, 1501)
      assertEq(over.error, 'over_amount', 'over the rest → refused in the database')
      const rest2 = await startPending('order', order.id, 1500)
      await callback(rest2.id!, 'COMPLETED')
      const { data: o2 } = await sb.from('orders').select('refund_status, refunded_amount, payment_status, status').eq('id', order.id).single()
      assertEq(o2, { refund_status: 'refunded', refunded_amount: 2000, payment_status: 'refunded', status: 'cancelled' }, 'fully refunded, order cancelled')
      assertEq((await startPending('order', order.id, 1)).error, 'over_amount', 'nothing left to refund')
    })

    await step('the API call reaches PawaPay sandbox (unknown deposit → refused, marked failed)', async () => {
      const o = await makeOrder(rest.id, buyer, { total: 700, status: 'confirmed', extra: { payment_status: 'paid', payment_id: randomUUID(), payment_amount: 700 } })
      track('orders', o.id)
      const r = await api<{ refund?: { id: string; status: string } }>('/api/admin/refunds', { cookie: superAdmin, body: { kind: 'order', id: o.id, amount: 700, reason: 'sandbox check' } })
      if (r.body.refund?.id) track('refunds', r.body.refund.id)
      assert([200, 502].includes(r.status), `answered (HTTP ${r.status}: ${r.raw.slice(0, 120)})`)
      const { data: row } = await sb.from('refunds').select('status').eq('order_id', o.id).single()
      if (r.status === 502) assertEq(row!.status, 'failed', 'refused by PawaPay → failed at once')
      else assertEq(row!.status, 'pending', 'accepted → pending')
      const { data: ord } = await sb.from('orders').select('refunded_amount').eq('id', o.id).single()
      assertEq(ord!.refunded_amount, 0, 'nothing counted as refunded')
    })

    await step('ticket: full refund with "cancel" cancels the booking', async () => {
      const evDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10)
      const ev = await makeEvent({ ticketPrice: 1500, maxTickets: 10, date: evDate })
      const { data: res, error } = await sb.from('event_reservations').insert({
        event_id: ev.id, customer_id: buyer.id, customer_name: buyer.name, customer_phone: buyer.phone, quantity: 2,
        total_price: 3000, payment_status: 'paid', payment_id: randomUUID(), reservation_status: 'confirmed', event_date: evDate,
      } as never).select('id').single()
      if (error || !res) throw new Error(`reservation insert: ${error?.message}`)
      const rid = (res as { id: string }).id
      track('event_reservations', rid)
      const info = await api<{ paid: number }>(`/api/admin/refunds?kind=reservation&id=${rid}`, { cookie: superAdmin })
      assertEq(info.body.paid, 3000, 'paid 3000')
      const p = await startPending('reservation', rid, 3000, true)
      await callback(p.id!, 'COMPLETED')
      const { data: r } = await sb.from('event_reservations').select('refund_status, refunded_amount, reservation_status').eq('id', rid).single()
      assertEq(r, { refund_status: 'refunded', refunded_amount: 3000, reservation_status: 'cancelled' }, 'refunded and cancelled')
      const list = await api<{ tickets: Array<{ id: string }> }>('/api/admin/paid-tickets', { cookie: superAdmin })
      assert(list.body.tickets.some(t => t.id === rid), 'listed in Billets payés')
    })

    await step('R1 config and R3 payout test: access and checks (no payout sent)', async () => {
      const cust = staffCookie({ id: buyer.id, email: '', name: 'x', role: 'customer' })
      assertEq((await api('/api/admin/pawapay/config', { cookie: cust })).status, 401, 'config: customer → 401')
      const conf = await api<{ environment?: string; operators?: unknown[] }>('/api/admin/pawapay/config', { cookie: superAdmin })
      assert([200, 502].includes(conf.status), `config answered (HTTP ${conf.status})`)
      assertEq(conf.body.environment, 'sandbox', 'local runs are sandbox')
      if (conf.status === 200) assert(Array.isArray(conf.body.operators), 'operators listed')
      assertEq((await api('/api/admin/pawapay/payout-test', { cookie: admin, body: { phone: '+237670000000', amount: 100 } })).status, 403, 'payout test: admin → 403')
      const big = await api<{ field?: string }>('/api/admin/pawapay/payout-test', { cookie: superAdmin, body: { phone: '+237670000000', amount: 501 } })
      assertEq([big.status, big.body.field], [400, 'amount'], 'over the cap → 400')
      const foreign = await api<{ field?: string }>('/api/admin/pawapay/payout-test', { cookie: superAdmin, body: { phone: buyer.phone, amount: 100 } })
      assertEq([foreign.status, foreign.body.field], [400, 'phone'], 'not a Cameroon MoMo number → 400')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
