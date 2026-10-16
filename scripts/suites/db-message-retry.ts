// P0 #3 — WhatsApp payments that "stall", against the real database.
//
// What it pins:
//   - BUG A: an order whose payment FAILED, re-claimed for a new deposit
//     ("payer"), goes back to 'pending' — so the new deposit's COMPLETED
//     outcome settles it to 'paid' and the customer is confirmed. Before the
//     fix the order stayed 'failed' and the outcome was ignored.
//   - A paid order cannot be re-claimed.
//   - Retry queue (needs supabase-message-retry.sql; skipped with a warning
//     until then): a notification Twilio refuses with 63038 is queued with
//     its full body; bot replies are not; the runner re-sends, backs off on
//     a repeat 63038 and stops the pass; the status-callback path queues an
//     accepted-then-failed message once and re-queues a failed retry.
//
// 🔴 SAFETY. Nothing reaches Twilio or PawaPay: globalThis.fetch answers
// api.twilio.com locally (status chosen per step) and refuses PawaPay. The
// runner is scoped to this suite's own queue rows (opts.ids), so real queued
// messages in the live database are never touched. Every phone is +999.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, warn, finish } from '../testkit/assert'
import { makeCustomer, makeRestaurant, makeOrder } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { claimOrderForDeposit } from '@/lib/whatsapp/ordering'
import { settleDeposit } from '@/lib/payments-settle'
import { sendWhatsApp } from '@/lib/whatsapp'
import {
  enqueueFailedSend, requeueFromStatusCallback, runMessageRetries, type RetrySendResult,
} from '@/lib/messageRetry'

const SUITE = 'db-message-retry'

// ── Network stub ────────────────────────────────────────────────────────────
let twilioMode: 'ok' | 'limit' = 'ok'
const twilioSends: Array<{ to: string; body: string }> = []
const forbiddenCalls: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('api.twilio.com')) {
    const params = new URLSearchParams(String(init?.body ?? ''))
    twilioSends.push({ to: params.get('To') ?? '', body: params.get('Body') ?? '' })
    if (twilioMode === 'limit') {
      return new Response(JSON.stringify({ code: 63038, message: 'Account exceeded the daily messages limit' }), { status: 429 })
    }
    return new Response(JSON.stringify({ sid: `SM_TEST_${twilioSends.length}`, status: 'queued' }), { status: 201 })
  }
  if (url.includes('pawapay')) {
    forbiddenCalls.push(url)
    return new Response('blocked by test', { status: 599 })
  }
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

async function queueRowsFor(relatedId: string) {
  const { data } = await sb.from('message_retry_queue')
    .select('id, status, attempts, body, last_error_code, last_log_id, next_attempt_at')
    .eq('related_id', relatedId)
  for (const r of data ?? []) track('message_retry_queue', r.id as string)
  return (data ?? []) as Array<{ id: string; status: string; attempts: number; body: string; last_error_code: string | null; last_log_id: string | null; next_attempt_at: string }>
}

async function main(): Promise<void> {
  try {
    const customer = await makeCustomer({ suiteNo: 61, name: 'Retry customer' })
    const owner    = await makeCustomer({ suiteNo: 61, name: 'Retry owner' })
    const rest     = await makeRestaurant({ ownerId: owner.id, label: 'msg_retry', whatsapp: owner.phone })

    // ── Bug A ───────────────────────────────────────────────────────────────
    await step('BUG A: failed order re-claimed by "payer" settles to paid', async () => {
      const oldDep = testName('dep_old')
      const newDep = testName('dep_new')
      const order = await makeOrder(rest.id, customer, {
        extra: { order_type: 'paid_order', payment_status: 'failed', payment_id: oldDep },
      })

      const claimed = await claimOrderForDeposit(order.id, newDep, 'MTN_MOMO_CMR', 2500)
      assertEq(claimed, true, 'failed order can be claimed')
      const { data: mid } = await sb.from('orders').select('payment_status, payment_id').eq('id', order.id).single()
      assertEq(mid?.payment_status, 'pending', "reset to 'pending'")
      assertEq(mid?.payment_id, newDep, 'points at the new deposit')

      const before = twilioSends.length
      const r = await settleDeposit(newDep, { status: 'COMPLETED' }, 'webhook')
      assertEq(r.kind !== 'unknown' && r.action, 'paid', "new deposit's COMPLETED settles the order")
      const { data: after } = await sb.from('orders').select('payment_status').eq('id', order.id).single()
      assertEq(after?.payment_status, 'paid', "order is 'paid'")
      assert(twilioSends.slice(before).some(m => m.to === `whatsapp:${customer.phone}`), 'customer confirmation sent')

      const again = await claimOrderForDeposit(order.id, testName('dep_late'), 'MTN_MOMO_CMR', 2500)
      assertEq(again, false, 'a paid order cannot be re-claimed')
    })

    // ── Retry queue ───────────────────────────────────────────────────────────
    const { error: tableErr } = await sb.from('message_retry_queue').select('id').limit(1)
    if (tableErr) {
      warn('message_retry_queue missing — run supabase-message-retry.sql; queue checks skipped')
    } else {
      const order = await makeOrder(rest.id, customer, { extra: { order_type: 'paid_order', payment_status: 'paid' } })
      const longBody = `✅ Paiement confirmé!\n${'x'.repeat(700)}`   // > the 500-char log prefix

      await step('63038 on a payment confirmation → queued with the full body', async () => {
        twilioMode = 'limit'
        const r = await sendWhatsApp(customer.phone, longBody, { context: 'payment_confirmation', relatedId: order.id })
        twilioMode = 'ok'
        assertEq(r.ok, false, 'send reported failed')
        assertEq(r.errorCode, '63038', 'error code surfaced')
        const rows = await queueRowsFor(order.id)
        assertEq(rows.length, 1, 'one queue row')
        assertEq(rows[0]?.status, 'pending', 'pending')
        assertEq(rows[0]?.body, longBody, 'full body kept')
        assertEq(rows[0]?.last_error_code, '63038', 'error recorded')
      })

      await step('63038 on a bot reply → not queued', async () => {
        const queued = await enqueueFailedSend({
          to: customer.phone, body: 'menu', context: 'bot_reply', relatedId: rest.id, errorCode: '63038', httpStatus: 429,
        })
        assertEq(queued, false, 'bot_reply not queued')
      })

      await step('runner: repeat 63038 backs off and stops; next pass sends', async () => {
        const [row] = await queueRowsFor(order.id)
        await sb.from('message_retry_queue').update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() } as never).eq('id', row.id)

        const limited: RetrySendResult = { ok: false, status: 429, errorCode: '63038', error: 'limit', logId: null }
        const s1 = await runMessageRetries({ send: async () => limited }, { ids: [row.id] })
        assertEq(s1.stoppedOnLimit, true, 'pass stops on 63038')
        let [r1] = await queueRowsFor(order.id)
        assertEq(r1.status, 'pending', 'still pending')
        assertEq(r1.attempts, 2, 'attempt counted')
        assert(new Date(r1.next_attempt_at).getTime() > Date.now() + 20 * 60_000, 'backed off ≥ 20 min')

        await sb.from('message_retry_queue').update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() } as never).eq('id', row.id)
        const sentTo: string[] = []
        const s2 = await runMessageRetries({
          send: async (to, body, o) => { sentTo.push(to); assertEq(o.retryOf, row.id, 'send marked as a retry'); return { ok: true, status: 201, logId: null } },
        }, { ids: [row.id] })
        assertEq(s2.sent, 1, 'sent on the next pass')
        assertEq(sentTo, [customer.phone], 'to the customer')
        ;[r1] = await queueRowsFor(order.id)
        assertEq(r1.status, 'sent', "row is 'sent'")
      })

      await step('status callback: accepted-then-63038 queued once; failed retry re-queued', async () => {
        const order2 = await makeOrder(rest.id, customer, { extra: { order_type: 'paid_order', payment_status: 'paid' } })
        const { data: log } = await sb.from('message_log').insert({
          channel: 'whatsapp', to_number: customer.phone, body: 'confirmation', status: 'failed',
          context: 'payment_confirmation', related_id: order2.id, error_code: '63038',
        } as never).select('id').single()
        const logId = (log as { id: string }).id

        await requeueFromStatusCallback(logId, '63038')
        let rows = await queueRowsFor(order2.id)
        assertEq(rows.length, 1, 'queued')
        assertEq(rows[0]?.attempts, 1, 'attempts 1')

        // The runner re-sent it; that retry's own log row then fails too.
        const { data: log2 } = await sb.from('message_log').insert({
          channel: 'whatsapp', to_number: customer.phone, body: 'confirmation', status: 'failed',
          context: 'payment_confirmation', related_id: order2.id, error_code: '63038',
        } as never).select('id').single()
        const log2Id = (log2 as { id: string }).id
        await sb.from('message_retry_queue').update({ status: 'sent', last_log_id: log2Id } as never).eq('id', rows[0].id)
        await requeueFromStatusCallback(log2Id, '63038')
        rows = await queueRowsFor(order2.id)
        assertEq(rows.length, 1, 'same row, no duplicate')
        assertEq(rows[0]?.status, 'pending', 'back to pending')
        assertEq(rows[0]?.attempts, 2, 'attempts 2')

        await requeueFromStatusCallback(logId, '21211')
        assertEq((await queueRowsFor(order2.id)).length, 1, 'non-retryable code queues nothing')
      })
    }

    assertEq(forbiddenCalls, [], 'no call reached PawaPay')
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
