// settleDeposit (lib/payments-settle.ts) against the real database — the one
// function the PawaPay webhook, the checkout poll and the pg_cron reconcile
// job all use to record a deposit outcome.
//
// What it pins:
//   - RACE: two callers settling the same deposit at once → exactly one wins,
//     one audit row, one set of WhatsApp messages.
//   - FAILED reservation releases BOTH events.tickets_sold AND the tier's
//     sold_count — once, even when two callers race.
//   - NON-FINAL PawaPay answers write nothing.
//   - BROADCAST settled by reconcile is marked paid but NOT sent.
//   - Failed-payment WhatsApp: sent via webhook/reconcile, not via the poll.
//
// 🔴 SAFETY. Nothing here reaches Twilio or PawaPay:
//   - PawaPay: settleDeposit takes the outcome as an argument; no status call.
//   - Twilio: globalThis.fetch is wrapped for api.twilio.com only — every send
//     is answered locally with a fake 201 and COUNTED, so the suite can assert
//     exactly which messages each path tries to send. Supabase traffic passes
//     through untouched. Every phone is +999 (unassignable) regardless.
//   - Broadcast fan-out: settleDeposit never calls /api/broadcasts/…/send;
//     the stub also fails the suite if anything tries.

import { sb, testName, testCode } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { makeCustomer, makeRestaurant, makeOrder, makeEvent, makeTier, type TestCustomer } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { settleDeposit, type SettleResult } from '@/lib/payments-settle'

const SUITE = 'db-payments-settle'

// ── Network stub ────────────────────────────────────────────────────────────
interface SentMessage { to: string; body: string }
const twilioSends: SentMessage[] = []
const forbiddenCalls: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('api.twilio.com')) {
    const params = new URLSearchParams(String(init?.body ?? ''))
    twilioSends.push({ to: params.get('To') ?? '', body: params.get('Body') ?? '' })
    return new Response(JSON.stringify({ sid: `SM_TEST_${twilioSends.length}`, status: 'queued' }), { status: 201 })
  }
  if (url.includes('/api/broadcasts/') || url.includes('pawapay')) {
    forbiddenCalls.push(url)
    return new Response('blocked by test', { status: 599 })
  }
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

function sendsTo(phone: string): SentMessage[] {
  return twilioSends.filter(m => m.to === `whatsapp:${phone}`)
}

let depSeq = 0
function depositId(): string { return testName(`dep${++depSeq}`) }

async function auditCount(targetId: string, action: string): Promise<number> {
  const { count } = await sb.from('audit_log').select('id', { count: 'exact', head: true })
    .eq('target_id', targetId).eq('action', action)
  return count ?? 0
}

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await sb.from(table).insert(row as never).select('id').single()
  if (error || !data) throw new Error(`insert ${table}: ${error?.message}`)
  const id = (data as { id: string }).id
  track(table, id)
  return id
}

function actions(results: SettleResult[]): string[] {
  return results.map(r => (r.kind === 'unknown' ? 'unknown' : r.action)).sort()
}

async function main() {
  try {
    const customer: TestCustomer = await makeCustomer({ name: 't_payer' })
    // Its own owner: owners/managers are vendor recipients, so a payer who
    // also owned the restaurant would get the vendor message too.
    const restaurant = await makeRestaurant()

    await step('order: webhook + poll race → settled once', async () => {
      const dep = depositId()
      const order = await makeOrder(restaurant.id, customer, { extra: { payment_status: 'pending', payment_id: dep } })
      const before = twilioSends.length

      const results = await Promise.all([
        settleDeposit(dep, { status: 'COMPLETED', correspondent: 'MTN_MOMO_CMR' }, 'webhook'),
        settleDeposit(dep, { status: 'COMPLETED', correspondent: 'MTN_MOMO_CMR' }, 'status_poll'),
      ])
      assertEq(actions(results), ['already_settled', 'paid'], 'exactly one caller wins the claim')

      const { data: row } = await sb.from('orders').select('payment_status, payment_at').eq('id', order.id).single()
      assertEq(row?.payment_status, 'paid', 'order is paid')
      assert(!!row?.payment_at, 'payment_at set')
      assertEq(await auditCount(order.id, 'payment_completed'), 1, 'ONE payment_completed audit row')
      assertEq(sendsTo(customer.phone).filter(m => twilioSends.indexOf(m) >= before).length, 1, 'customer notified ONCE')
      assertEq(sendsTo(restaurant.whatsapp).filter(m => twilioSends.indexOf(m) >= before).length, 1, 'vendor notified ONCE')

      const late = await settleDeposit(dep, { status: 'COMPLETED' }, 'reconcile')
      assertEq(late.kind !== 'unknown' && late.action, 'already_settled', 'a later reconcile is a no-op')
    })

    await step('order: non-final PawaPay answers write nothing', async () => {
      const dep = depositId()
      const order = await makeOrder(restaurant.id, customer, { extra: { payment_status: 'pending', payment_id: dep } })
      const before = twilioSends.length
      for (const status of ['ACCEPTED', 'SUBMITTED', 'ENQUEUED', 'DUPLICATE_IGNORED']) {
        const r = await settleDeposit(dep, { status }, 'reconcile')
        assertEq(r.kind !== 'unknown' && r.action, 'not_final', `${status} → not_final`)
      }
      const { data: row } = await sb.from('orders').select('payment_status').eq('id', order.id).single()
      assertEq(row?.payment_status, 'pending', 'order still pending')
      assertEq(twilioSends.length, before, 'no WhatsApp sent')
      assertEq(await auditCount(order.id, 'payment_completed') + await auditCount(order.id, 'payment_failed'), 0, 'no audit rows')
    })

    await step('order: failed-payment WhatsApp on webhook/reconcile, not poll', async () => {
      const viaPoll = depositId()
      const o1 = await makeOrder(restaurant.id, customer, { extra: { payment_status: 'pending', payment_id: viaPoll } })
      let before = twilioSends.length
      await settleDeposit(viaPoll, { status: 'FAILED', failureReason: 'test' }, 'status_poll')
      assertEq((await sb.from('orders').select('payment_status').eq('id', o1.id).single()).data?.payment_status, 'failed', 'poll: order failed')
      assertEq(twilioSends.length - before, 0, 'poll: NO failure WhatsApp (web customer sees it on screen)')
      assertEq(await auditCount(o1.id, 'payment_failed'), 1, 'poll: payment_failed audited')

      const viaReconcile = depositId()
      const o2 = await makeOrder(restaurant.id, customer, { extra: { payment_status: 'pending', payment_id: viaReconcile } })
      before = twilioSends.length
      await settleDeposit(viaReconcile, { status: 'REJECTED' }, 'reconcile')
      assertEq((await sb.from('orders').select('payment_status').eq('id', o2.id).single()).data?.payment_status, 'failed', 'reconcile: order failed')
      const sent = twilioSends.slice(before)
      assertEq(sent.length, 1, 'reconcile: one WhatsApp sent')
      assert(sent[0]?.to === `whatsapp:${customer.phone}` && /Paiement échoué|Payment failed/.test(sent[0].body), 'reconcile: it is the failure notice, to the customer')
    })

    await step('reservation FAILED: releases tickets_sold AND tier sold_count, once', async () => {
      const event = await makeEvent({ ticketPrice: 1000, extra: { tickets_sold: 5 } })
      const tier = await makeTier(event.id, { price: 1000, extra: { sold_count: 3 } })
      const dep = depositId()
      const resId = await insert('event_reservations', {
        event_id: event.id, customer_id: customer.id, customer_name: customer.name, customer_phone: customer.phone,
        quantity: 2, total_price: 2000, payment_status: 'pending', payment_id: dep,
        reservation_status: 'confirmed', reservation_code: testCode(`r${depSeq}`), tier_id: tier.id,
      })
      const before = twilioSends.length

      const results = await Promise.all([
        settleDeposit(dep, { status: 'FAILED' }, 'webhook'),
        settleDeposit(dep, { status: 'FAILED' }, 'reconcile'),
      ])
      assertEq(actions(results), ['already_settled', 'failed'], 'exactly one caller wins')

      const { data: ev } = await sb.from('events').select('tickets_sold').eq('id', event.id).single()
      const { data: t } = await sb.from('event_ticket_tiers').select('sold_count').eq('id', tier.id).single()
      assertEq(ev?.tickets_sold, 3, 'events.tickets_sold 5 → 3 (released once, not twice)')
      assertEq(t?.sold_count, 1, 'tier sold_count 3 → 1 (released once, not twice)')
      assertEq((await sb.from('event_reservations').select('payment_status').eq('id', resId).single()).data?.payment_status, 'failed', 'reservation failed')
      assertEq(await auditCount(resId, 'event_payment_failed'), 1, 'ONE event_payment_failed audit row')
      assertEq(sendsTo(customer.phone).filter(m => twilioSends.indexOf(m) >= before).length, 1, 'failure notice sent ONCE')
    })

    await step('reservation COMPLETED: paid, seats kept', async () => {
      const event = await makeEvent({ ticketPrice: 1000, extra: { tickets_sold: 4 } })
      const tier = await makeTier(event.id, { price: 1000, extra: { sold_count: 2 } })
      const dep = depositId()
      const resId = await insert('event_reservations', {
        event_id: event.id, customer_id: customer.id, customer_name: customer.name, customer_phone: customer.phone,
        quantity: 2, total_price: 2000, payment_status: 'pending', payment_id: dep,
        reservation_status: 'confirmed', reservation_code: testCode(`r${depSeq}`), tier_id: tier.id,
      })
      const r = await settleDeposit(dep, { status: 'COMPLETED', correspondent: 'MTN_MOMO_CMR' }, 'reconcile')
      assertEq(r.kind !== 'unknown' && r.action, 'paid', 'reconcile settles the reservation paid')
      assertEq((await sb.from('event_reservations').select('payment_status').eq('id', resId).single()).data?.payment_status, 'paid', 'row is paid')
      assertEq((await sb.from('events').select('tickets_sold').eq('id', event.id).single()).data?.tickets_sold, 4, 'tickets_sold untouched')
      assertEq((await sb.from('event_ticket_tiers').select('sold_count').eq('id', tier.id).single()).data?.sold_count, 2, 'tier sold_count untouched')
      assertEq(await auditCount(resId, 'event_payment_completed'), 1, 'audited once')
    })

    await step('broadcast via reconcile: paid, NOT sent', async () => {
      const dep = depositId()
      const id = await insert('broadcasts', {
        sender_id: customer.id, sender_type: 'publisher', title: testName('bcast'), message: 'test',
        target_city: testName('city'), recipient_count: 0, cost: 1000,
        payment_status: 'pending', status: 'draft', payment_id: dep,
      })
      const before = twilioSends.length
      const r = await settleDeposit(dep, { status: 'COMPLETED' }, 'reconcile')
      assertEq(r.kind !== 'unknown' && r.action, 'paid', 'settled paid')
      const { data: row } = await sb.from('broadcasts').select('payment_status, status, sent_at').eq('id', id).single()
      assertEq(row?.payment_status, 'paid', 'payment_status paid')
      assertEq(row?.status, 'paid', "status 'paid' — not 'sending'/'sent'")
      assertEq(row?.sent_at ?? null, null, 'sent_at still null')
      assertEq(twilioSends.length - before, 0, 'no WhatsApp at all')
      assertEq(forbiddenCalls.filter(u => u.includes(id)).length, 0, 'no call to /api/broadcasts/<id>/send')
      const { data: audit } = await sb.from('audit_log').select('metadata').eq('target_id', customer.id)
        .eq('action', 'broadcast_paid').contains('metadata', { broadcast_id: id }).maybeSingle()
      assertEq((audit?.metadata as { fan_out?: string } | null)?.fan_out, 'not_triggered_by_reconcile', 'audit marks the unsent gap')
    })

    await step('promotion: paid → pending_review; failed → rejected', async () => {
      const mk = async (dep: string) => insert('promotions', {
        promoter_id: customer.id, target_type: 'restaurant', target_id: restaurant.id, placement: 'top_list',
        city: testName('city'), start_date: new Date().toISOString(), end_date: new Date(Date.now() + 86400000).toISOString(),
        total_budget: 1000, payment_status: 'pending', status: 'draft', payment_id: dep,
      })
      const d1 = depositId(); const p1 = await mk(d1)
      await settleDeposit(d1, { status: 'COMPLETED' }, 'reconcile')
      const r1 = (await sb.from('promotions').select('payment_status, status').eq('id', p1).single()).data
      assertEq([r1?.payment_status, r1?.status], ['paid', 'pending_review'], 'COMPLETED → paid / pending_review')

      const d2 = depositId(); const p2 = await mk(d2)
      await settleDeposit(d2, { status: 'FAILED' }, 'webhook')
      const r2 = (await sb.from('promotions').select('payment_status, status').eq('id', p2).single()).data
      assertEq([r2?.payment_status, r2?.status], ['failed', 'rejected'], 'FAILED → failed / rejected')
    })

    await step('unknown deposit', async () => {
      const r = await settleDeposit(depositId(), { status: 'COMPLETED' }, 'webhook')
      assertEq(r.kind, 'unknown', 'no matching row → unknown, nothing written')
    })

    await step('nothing escaped', async () => {
      assertEq(forbiddenCalls, [], 'no call reached PawaPay or the broadcast send route')
      assert(twilioSends.every(m => m.to.startsWith('whatsapp:+999')), 'every WhatsApp was to a +999 test number (and stubbed)')
    })
  } finally {
    await teardown()
    globalThis.fetch = realFetch
  }
  finish(SUITE)
}

main()
