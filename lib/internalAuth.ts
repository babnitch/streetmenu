// Internal-caller authentication: Authorization: Bearer <INTERNAL_API_SECRET>.
//
// For machine-only routes — the broadcast fan-out (/api/broadcasts/[id]/send,
// called by the payment webhook) and the payment reconcile job
// (/api/payments/reconcile, called by Supabase pg_cron). Never callable
// without the secret.
//
// A DIFFERENT secret from CRON_SECRET (app/api/admin/cleanup-expired): that
// one belongs to Vercel cron and is handed to a third party, so reusing it
// would widen what a leaked cron secret can do. Secrets stay scoped.
//
// Constant-time compare rather than `===`: `===` short-circuits on the first
// differing byte, which leaks the secret's prefix through response timing.

import { timingSafeEqual } from 'crypto'

const BEARER = 'Bearer '

export type InternalAuthOutcome =
  | { ok: true }
  | { ok: false; status: 401 | 503; logLine: string }

export function authorizeInternal(req: { headers: Headers }): InternalAuthOutcome {
  const secret = process.env.INTERNAL_API_SECRET

  // FAIL CLOSED, LOUDLY. An unset secret must never mean "allow everyone" —
  // the same failure class as a missing env var silently disabling webhook
  // verification. 503 rather than 401 so the cause is distinguishable in logs
  // and monitoring: 401 means someone called with the wrong credential, 503
  // means this deployment cannot authenticate anyone at all.
  if (!secret) {
    return {
      ok: false,
      status: 503,
      logLine:
        'INTERNAL_API_SECRET is not set on this deployment — refusing EVERY internal call ' +
        '(broadcast fan-out from the payment webhook, and the pg_cron payment reconcile). ' +
        'Set INTERNAL_API_SECRET in Vercel (Production) and redeploy.',
    }
  }

  const header = req.headers.get('authorization') ?? ''
  if (!header.startsWith(BEARER)) {
    return { ok: false, status: 401, logLine: 'missing or malformed Authorization header' }
  }

  const provided = Buffer.from(header.slice(BEARER.length))
  const expected = Buffer.from(secret)
  // timingSafeEqual throws on a length mismatch, so that is checked first —
  // the length of a secret is not itself the secret.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, logLine: 'bearer token did not match' }
  }

  return { ok: true }
}
