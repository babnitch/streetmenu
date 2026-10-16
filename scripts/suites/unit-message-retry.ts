// Pure rules behind the WhatsApp payment fixes (P0 #3): which Twilio
// failures are worth retrying, the backoff, and how a createDeposit failure
// is classified for the customer. No I/O.

import {
  isRetryableFailure, backoffMs, MAX_ATTEMPTS, RETRYABLE_CONTEXTS,
} from '@/lib/messageRetry'
import { depositFailure } from '@/lib/whatsapp/ordering'
import { isPawaPayTimeout } from '@/lib/pawapay'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-message-retry'

async function main(): Promise<void> {
  await step('retryable Twilio failures', () => {
    assertEq(isRetryableFailure('63038'), true, '63038 trial daily cap → retry')
    assertEq(isRetryableFailure('20429'), true, '20429 too many requests → retry')
    assertEq(isRetryableFailure('63018'), true, '63018 channel rate limit → retry')
    assertEq(isRetryableFailure(null, 429), true, 'HTTP 429 → retry')
    assertEq(isRetryableFailure(null, 0), true, 'network failure → retry')
    assertEq(isRetryableFailure(null, 503), true, 'Twilio 5xx → retry')
    assertEq(isRetryableFailure('21211', 400), false, '21211 invalid number → never')
    assertEq(isRetryableFailure('63016', 400), false, '63016 outside 24h window → never')
    assertEq(isRetryableFailure('20003', 401), false, '401 bad credentials → never')
    assertEq(isRetryableFailure(null), false, 'no code, no status → never')
  })

  await step('only notifications are re-sent', () => {
    assert(RETRYABLE_CONTEXTS.has('payment_confirmation'), 'payment_confirmation retried')
    assert(RETRYABLE_CONTEXTS.has('order_notification'), 'order_notification retried')
    assert(!RETRYABLE_CONTEXTS.has('bot_reply'), 'bot_reply not retried')
    assert(!RETRYABLE_CONTEXTS.has('verification_code'), 'verification_code not retried')
    assert(!RETRYABLE_CONTEXTS.has('broadcast'), 'broadcast not retried')
  })

  await step('backoff grows and is capped', () => {
    assertEq(backoffMs(1), 10 * 60_000, '1st retry after 10 min')
    assertEq(backoffMs(2), 30 * 60_000, '2nd after 30 min')
    assertEq(backoffMs(6), 480 * 60_000, '6th after 8 h')
    assertEq(backoffMs(50), 480 * 60_000, 'capped at 8 h')
    assertEq(backoffMs(0), 10 * 60_000, 'defensive floor')
    assert(MAX_ATTEMPTS >= 6, 'enough attempts to outlast a 24h window')
  })

  await step('createDeposit failures: refused vs unknown outcome', () => {
    const refused = depositFailure(new Error('Paiement refusé par PawaPay / Payment rejected: PAYER_LIMIT_REACHED'))
    assertEq(refused.definitive, true, 'PawaPay REJECTED → definitive')
    assertEq(refused.reason, 'PAYER_LIMIT_REACHED', "only PawaPay's reason is kept")

    const unsupported = depositFailure(new Error('Numéro non supporté pour le paiement / Unsupported payment number: +1555'))
    assertEq(unsupported.definitive, true, 'never sent → definitive')

    const server = depositFailure(new Error('Paiement refusé par PawaPay / Payment rejected: HTTP 502'))
    assertEq(server.definitive, false, 'PawaPay 5xx → outcome unknown')

    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    assertEq(isPawaPayTimeout(timeout), true, 'TimeoutError recognised')
    assertEq(depositFailure(timeout).definitive, false, 'timeout → outcome unknown')

    assertEq(depositFailure(new TypeError('fetch failed')).definitive, false, 'network error → outcome unknown')
  })

  finish(SUITE)
}

void main()
