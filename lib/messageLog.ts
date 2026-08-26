// Message log — one row per WhatsApp / SMS we hand to Twilio.
//
// Written from lib/whatsapp.ts and lib/sms.ts right after the Twilio call
// returns, then updated asynchronously by POST /api/twilio/status-callback
// as the message moves queued → sent → delivered → read (or fails).
//
// HARD RULE: logging must never break sending. Every function here swallows
// its own errors and resolves — a logging outage costs us observability,
// not a customer's verification code.
//
// Table: supabase-message-log.sql

import { supabaseAdmin } from '@/lib/supabaseAdmin'

// Bodies are kept for the admin log preview and for debugging a failed
// send; the full text is rarely needed and some of it is PII, so we store
// a bounded prefix.
export const MAX_LOGGED_BODY = 500

export type MessageChannel = 'whatsapp' | 'sms'
export type MessageStatus  = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered'

// What triggered a message. Not an enum in the DB (a new notification type
// shouldn't need a migration) but this union keeps call sites honest.
export type MessageContext =
  | 'verification_code'
  | 'order_notification'
  | 'order_status_update'
  | 'payment_confirmation'
  | 'event_reservation'
  | 'event_update'
  | 'broadcast'
  | 'direct_message'
  | 'subscription_alert'
  | 'rating_prompt'
  | 'account_notice'
  | 'team_invitation'
  | 'bot_reply'
  | (string & {})

// Threaded through sendWhatsApp / sendSMS by every caller so the admin log
// can answer "why did this person get a message?".
export interface SendOptions {
  context?:    MessageContext
  relatedId?:  string | null   // order_id, event_id, reservation_id, …
  customerId?: string | null   // recipient customer when the caller knows it
  /** Opt out of logging entirely (used by the log's own retry paths). */
  skipLog?:    boolean
}

interface LogInput extends SendOptions {
  channel:       MessageChannel
  from:          string
  to:            string
  body:          string
  status:        MessageStatus
  twilioSid?:    string | null
  errorCode?:    string | null
  errorMessage?: string | null
}

// Postgres rejects a malformed uuid outright, which would fail the whole
// insert. Callers hand us ids from URLs and Twilio params, so validate
// before we let one near the column.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function asUuid(value: string | null | undefined): string | null {
  if (!value) return null
  return UUID_RE.test(value.trim()) ? value.trim() : null
}

// Stored numbers are normalised to bare +E.164 so a WhatsApp send and an
// SMS to the same person group together in the admin log and in a
// customer's history.
export function normalizeLogNumber(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '')
}

/**
 * Insert one message_log row. Never throws, never rejects.
 *
 * Returns the new row id when the insert succeeded, or null — callers
 * ignore the result today, it exists for tests.
 */
export async function logMessage(input: LogInput): Promise<string | null> {
  if (input.skipLog) return null
  try {
    const { data, error } = await supabaseAdmin
      .from('message_log')
      .insert({
        twilio_sid:    input.twilioSid ?? null,
        direction:     'outbound',
        channel:       input.channel,
        from_number:   normalizeLogNumber(input.from),
        to_number:     normalizeLogNumber(input.to),
        body:          (input.body ?? '').slice(0, MAX_LOGGED_BODY),
        status:        input.status,
        error_code:    input.errorCode ?? null,
        error_message: input.errorMessage ? input.errorMessage.slice(0, 500) : null,
        context:       input.context ?? null,
        related_id:    asUuid(input.relatedId),
        customer_id:   asUuid(input.customerId),
      })
      .select('id')
      .maybeSingle()

    if (error) {
      console.error(`[message-log] insert failed (${input.channel}/${input.context ?? '-'}):`, error.message)
      return null
    }
    return (data as { id: string } | null)?.id ?? null
  } catch (e) {
    console.error('[message-log] insert threw:', (e as Error).message)
    return null
  }
}

// ── Status callback URL ──────────────────────────────────────────────────────
// Twilio POSTs delivery updates here. Configured per-message (rather than on
// the Twilio number) so the URL follows the deployment the message was sent
// from. Must be publicly reachable — on localhost Twilio simply drops the
// callback and rows stay 'queued', which is fine for dev.
export function statusCallbackUrl(): string | null {
  const explicit = process.env.TWILIO_STATUS_CALLBACK_URL
  if (explicit) return explicit
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://streetmenu.vercel.app'
  // A localhost base would make Twilio reject the create call outright
  // (error 21609 — invalid StatusCallback URL), so skip it in dev.
  if (/localhost|127\.0\.0\.1/.test(base)) return null
  return `${base.replace(/\/$/, '')}/api/twilio/status-callback`
}
