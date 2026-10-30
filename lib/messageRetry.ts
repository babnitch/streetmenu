// WhatsApp notification retry queue — server-only.
//
// Twilio refuses some sends for reasons that go away on their own: the trial
// account's 50-messages-per-24h cap (63038) and rate limits. When that hits a
// NOTIFICATION (a payment confirmation, an order update) the customer is left
// waiting for a message that never comes. Those sends are queued in
// message_retry_queue (supabase-message-retry.sql) and re-sent with backoff by
// runMessageRetries(), which the pawapay-reconcile cron calls every 10 min.
//
// Two ways in:
//   - enqueueFailedSend()      — Twilio rejected the API call (lib/whatsapp.ts)
//   - requeueFromStatusCallback() — Twilio accepted, then reported failed
//                                   (app/api/twilio/status-callback)
//
// Like the message log, nothing here may break a send: every write is
// awaited but errors are logged, never thrown.
//
// No module-level import of lib/whatsapp (it imports this file); the runner
// loads it lazily.

import { supabaseAdmin } from '@/lib/supabaseAdmin'

// ── Rules ─────────────────────────────────────────────────────────────────────

// Only notifications are worth re-sending later. A bot reply or a
// verification code delivered hours late is noise; broadcasts have their own
// fan-out and are paid per recipient.
export const RETRYABLE_CONTEXTS: ReadonlySet<string> = new Set([
  'payment_confirmation',
  'order_notification',
  'order_status_update',
  'event_reservation',
  'event_update',
])

// Twilio codes that mean "not now", not "never".
//   63038 — account exceeded its daily message limit (trial: 50 / 24h)
//   63018 — WhatsApp channel rate limit
//   20429 — too many concurrent API requests
//   14107 — SMS send rate limit
export const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set(['63038', '63018', '20429', '14107'])

/** HTTP status 0 = network failure, 429 = throttled, 5xx = Twilio outage. */
export function isRetryableFailure(errorCode: string | null | undefined, httpStatus?: number): boolean {
  if (errorCode && RETRYABLE_ERROR_CODES.has(String(errorCode))) return true
  if (httpStatus === undefined) return false
  return httpStatus === 0 || httpStatus === 429 || httpStatus >= 500
}

export const MAX_ATTEMPTS = 8
export const MAX_AGE_MS   = 48 * 60 * 60 * 1000

// Delay before the next try, by number of failed sends so far. The trial cap
// is a ROLLING 24h window, so the tail stretches out rather than hammering.
const BACKOFF_MIN = [10, 30, 60, 120, 240, 480]
export function backoffMs(failedSends: number): number {
  const i = Math.min(Math.max(failedSends, 1), BACKOFF_MIN.length) - 1
  return BACKOFF_MIN[i] * 60 * 1000
}

// ── Enqueue ───────────────────────────────────────────────────────────────────

export interface FailedSend {
  to:          string            // bare +E.164 or whatsapp:+…
  body:        string
  context?:    string | null
  relatedId?:  string | null
  customerId?: string | null
  logId?:      string | null     // message_log row of this attempt
  errorCode?:  string | null
  error?:      string | null
  httpStatus?: number
}

function bareNumber(to: string): string {
  return to.replace(/^whatsapp:/i, '')
}

/** Twilio refused the API call. Queues the message when it is a retryable
 *  notification; returns whether it was queued. */
export async function enqueueFailedSend(f: FailedSend): Promise<boolean> {
  if (!f.context || !RETRYABLE_CONTEXTS.has(f.context)) return false
  if (!isRetryableFailure(f.errorCode, f.httpStatus)) return false
  try {
    const { error } = await supabaseAdmin.from('message_retry_queue').insert({
      last_log_id:     f.logId ?? null,
      to_number:       bareNumber(f.to),
      body:            f.body,
      context:         f.context,
      related_id:      f.relatedId ?? null,
      customer_id:     f.customerId ?? null,
      attempts:        1,
      next_attempt_at: new Date(Date.now() + backoffMs(1)).toISOString(),
      last_error_code: f.errorCode ?? (f.httpStatus !== undefined ? `http_${f.httpStatus}` : null),
      last_error:      (f.error ?? '').slice(0, 500) || null,
    })
    if (error) {
      console.error(`[message-retry] enqueue FAILED to=${f.to} context=${f.context}: ${error.message}`)
      return false
    }
    console.warn(`[message-retry] QUEUED to=${f.to} context=${f.context} code=${f.errorCode ?? f.httpStatus ?? '-'} — retry in ${backoffMs(1) / 60000} min`)
    return true
  } catch (e) {
    console.error('[message-retry] enqueue threw:', (e as Error).message)
    return false
  }
}

/** Twilio accepted a message and later reported it failed/undelivered. If it
 *  was itself a retry, push that queue row back to pending; otherwise queue
 *  the original (when it is a retryable notification). */
export async function requeueFromStatusCallback(logId: string, errorCode: string | null): Promise<void> {
  if (!isRetryableFailure(errorCode)) return
  try {
    const { data: existing } = await supabaseAdmin
      .from('message_retry_queue')
      .select('id, attempts, created_at, status')
      .eq('last_log_id', logId)
      .maybeSingle()

    if (existing) {
      const attempts = Number(existing.attempts ?? 0) + 1
      const tooOld   = Date.now() - new Date(existing.created_at as string).getTime() > MAX_AGE_MS
      const giveUp   = attempts >= MAX_ATTEMPTS || tooOld
      await supabaseAdmin.from('message_retry_queue').update({
        status:          giveUp ? 'gave_up' : 'pending',
        attempts,
        next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
        last_error_code: errorCode,
        last_error:      `Twilio error ${errorCode} (status callback)`,
        updated_at:      new Date().toISOString(),
      }).eq('id', existing.id)
      console.warn(`[message-retry] retry ${existing.id} failed after accept (code ${errorCode}) → ${giveUp ? 'GAVE UP' : `attempt ${attempts + 1} later`}`)
      return
    }

    const { data: log } = await supabaseAdmin
      .from('message_log')
      .select('id, channel, to_number, body, context, related_id, customer_id')
      .eq('id', logId)
      .maybeSingle()
    if (!log || log.channel !== 'whatsapp' || !log.body) return
    if (!log.context || !RETRYABLE_CONTEXTS.has(log.context as string)) return
    if ((log.body as string).includes('••••')) return   // a masked code: re-sending it would be useless

    const { error } = await supabaseAdmin.from('message_retry_queue').insert({
      last_log_id:     log.id,
      to_number:       log.to_number,
      body:            log.body,
      context:         log.context,
      related_id:      log.related_id,
      customer_id:     log.customer_id,
      attempts:        1,
      next_attempt_at: new Date(Date.now() + backoffMs(1)).toISOString(),
      last_error_code: errorCode,
      last_error:      `Twilio error ${errorCode} (status callback)`,
    })
    // 23505 = a duplicate callback for the same message already queued it.
    if (error && error.code !== '23505') {
      console.error(`[message-retry] requeue FAILED log=${logId}: ${error.message}`)
      return
    }
    if (!error) console.warn(`[message-retry] QUEUED from status callback log=${logId} to=${log.to_number} context=${log.context} code=${errorCode}`)
  } catch (e) {
    console.error('[message-retry] requeue threw:', (e as Error).message)
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export interface RetrySendResult {
  ok:         boolean
  status:     number
  errorCode?: string
  error?:     string
  logId?:     string | null
}

export interface RetryDeps {
  send: (to: string, body: string, opts: { context?: string | null; relatedId?: string | null; customerId?: string | null; retryOf: string }) => Promise<RetrySendResult>
}

export const liveRetryDeps: RetryDeps = {
  send: async (to, body, opts) => {
    const { sendWhatsApp } = await import('@/lib/whatsapp')
    return sendWhatsApp(to, body, {
      context:    opts.context ?? undefined,
      relatedId:  opts.relatedId,
      customerId: opts.customerId,
      retryOf:    opts.retryOf,
    })
  },
}

export interface RetrySummary {
  due:     number
  sent:    number
  failed:  number
  gaveUp:  number
  stoppedOnLimit: boolean
}

export interface RetryRunOptions {
  /** Max sends this run (default 10). */
  limit?: number
  /** Only these queue rows — lets the test suite run against the live
   *  database without touching real queued messages. */
  ids?:   string[]
}

// One pass over the due rows. Capped per run so a backlog drains gradually
// instead of burning the whole daily allowance in one go, and stops at the
// first 63038 — if the cap is still hit, the rest would fail the same way.
export async function runMessageRetries(
  deps: RetryDeps = liveRetryDeps,
  opts: RetryRunOptions = {},
): Promise<RetrySummary> {
  const summary: RetrySummary = { due: 0, sent: 0, failed: 0, gaveUp: 0, stoppedOnLimit: false }
  const nowIso = new Date().toISOString()

  // Anything older than MAX_AGE is no longer worth sending.
  let expireQ = supabaseAdmin
    .from('message_retry_queue')
    .update({ status: 'gave_up', last_error: 'expired (48h)', updated_at: nowIso })
    .eq('status', 'pending')
    .lt('created_at', new Date(Date.now() - MAX_AGE_MS).toISOString())
  if (opts.ids) expireQ = expireQ.in('id', opts.ids)
  const { data: expired } = await expireQ.select('id')
  summary.gaveUp += expired?.length ?? 0

  let dueQ = supabaseAdmin
    .from('message_retry_queue')
    .select('id, to_number, body, context, related_id, customer_id, attempts')
    .eq('status', 'pending')
    .lte('next_attempt_at', nowIso)
  if (opts.ids) dueQ = dueQ.in('id', opts.ids)
  const { data: due, error } = await dueQ
    .order('next_attempt_at', { ascending: true })
    .limit(opts.limit ?? 10)
  if (error) {
    console.error('[message-retry] load due rows failed:', error.message)
    return summary
  }
  summary.due = due?.length ?? 0

  for (const row of due ?? []) {
    // Claim the row so two overlapping cron runs never send it twice.
    const { data: claimed } = await supabaseAdmin
      .from('message_retry_queue')
      .update({ status: 'sending', updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'pending')
      .select('id').maybeSingle()
    if (!claimed) continue

    const r = await deps.send(row.to_number as string, row.body as string, {
      context:    row.context as string | null,
      relatedId:  row.related_id as string | null,
      customerId: row.customer_id as string | null,
      retryOf:    row.id as string,
    })
    const attempts = Number(row.attempts ?? 0) + 1

    if (r.ok) {
      // 'sent' = Twilio accepted it. If it fails afterwards, the status
      // callback finds this row through last_log_id and re-queues it.
      await supabaseAdmin.from('message_retry_queue').update({
        status: 'sent', attempts, last_log_id: r.logId ?? null, updated_at: new Date().toISOString(),
      }).eq('id', row.id)
      summary.sent++
      console.log(`[message-retry] SENT ${row.id} to=${row.to_number} context=${row.context} attempt=${attempts}`)
      continue
    }

    const retryable = isRetryableFailure(r.errorCode, r.status)
    const giveUp    = !retryable || attempts >= MAX_ATTEMPTS
    await supabaseAdmin.from('message_retry_queue').update({
      status:          giveUp ? 'gave_up' : 'pending',
      attempts,
      last_log_id:     r.logId ?? null,
      next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
      last_error_code: r.errorCode ?? `http_${r.status}`,
      last_error:      (r.error ?? '').slice(0, 500) || null,
      updated_at:      new Date().toISOString(),
    }).eq('id', row.id)
    if (giveUp) summary.gaveUp++
    else summary.failed++
    console.warn(`[message-retry] attempt ${attempts} FAILED ${row.id} to=${row.to_number} code=${r.errorCode ?? r.status} → ${giveUp ? 'GAVE UP' : 'requeued'}`)

    if (r.errorCode === '63038') {
      summary.stoppedOnLimit = true
      break
    }
  }
  return summary
}
