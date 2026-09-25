import { NextRequest, NextResponse } from 'next/server'
import { writeAudit } from '@/lib/audit'
import {
  verifyPawaPayCallback, logCallbackVerification, shouldRejectCallback,
  type PawaPayCorrespondent,
} from '@/lib/pawapay'
import { settleDeposit } from '@/lib/payments-settle'

export const dynamic = 'force-dynamic'

// POST /api/payments/webhook
// PawaPay calls this whenever a deposit (or payout) reaches a terminal status.
// Body shape (deposit):
//   { depositId, status: 'COMPLETED'|'FAILED'|'REJECTED', amount, currency,
//     correspondent, failureReason?: { failureMessage } }
//
// We:
//   1. Verify PawaPay's RFC 9421 signature (lib/pawapay.ts). STAGE 2 is
//      LOG-ONLY: the result is logged and the callback is processed either
//      way. Rejection is the PAWAPAY_REJECT_INVALID_CALLBACKS switch — see
//      the ROLLOUT note in lib/pawapay.ts before flipping it.
//   2. Settle the deposit through lib/payments-settle.ts (orders,
//      reservations, broadcasts, promotions) — atomic claim, audit, WhatsApp.
//   3. For a paid broadcast this callback won, trigger the fan-out.
//
// Idempotent: a duplicate or late callback loses the claim and is a no-op.
export async function POST(req: NextRequest) {
  // Exact bytes — the Content-Digest is over what was sent, not over a
  // decoded-and-re-encoded string.
  const rawBytes = Buffer.from(await req.arrayBuffer())
  const rawBody = rawBytes.toString('utf8')

  const headers: Record<string, string> = {}
  req.headers.forEach((value, name) => { headers[name.toLowerCase()] = value })

  // @authority / @path must be what PawaPay addressed, not an internal hop.
  const internal = new URL(req.url)
  const host  = headers['x-forwarded-host'] ?? headers['host'] ?? internal.host
  const proto = headers['x-forwarded-proto'] ?? internal.protocol.replace(':', '')
  const url   = `${proto}://${host}${internal.pathname}${internal.search}`

  const verification = await verifyPawaPayCallback({ method: req.method, url, headers, rawBody: rawBytes })
  logCallbackVerification(verification, `url=${url}`)
  if (shouldRejectCallback(verification)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  let payload: {
    depositId?: string
    payoutId?:  string
    status?:    string
    amount?:    string | number
    currency?:  string
    correspondent?: PawaPayCorrespondent
    failureReason?: { failureMessage?: string }
  }
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // ── Payout callback path (admin payouts) ───────────────────────────────────
  if (payload.payoutId && !payload.depositId) {
    const action = payload.status === 'COMPLETED' ? 'payout_completed' : 'payout_failed'
    await writeAudit({
      action,
      targetType: 'order',
      targetId:   payload.payoutId,
      metadata:   { payout_id: payload.payoutId, status: payload.status, amount: payload.amount, currency: payload.currency },
    })
    return NextResponse.json({ ok: true })
  }

  // ── Deposit callback path ──────────────────────────────────────────────────
  const depositId = payload.depositId
  if (!depositId) return NextResponse.json({ error: 'no depositId' }, { status: 400 })

  // Settling is lib/payments-settle.ts, shared with the status poll and the
  // reconcile job — an atomic pending→terminal claim, so a callback racing a
  // poll (or a duplicate callback) notifies once and the loser no-ops.
  const result = await settleDeposit(depositId, {
    status:        payload.status ?? '',
    amount:        payload.amount,
    currency:      payload.currency,
    correspondent: payload.correspondent,
    failureReason: payload.failureReason?.failureMessage ?? null,
  }, 'webhook')

  if (result.kind === 'unknown') {
    console.warn(`[payments/webhook] no order, reservation, broadcast or promotion matches depositId=${depositId}`)
    return NextResponse.json({ ok: true, ignored: 'unknown deposit' })
  }
  if (result.action === 'already_settled') {
    return NextResponse.json({ ok: true, ignored: 'already settled' })
  }

  // Broadcast fan-out stays webhook-only, and now fires only when THIS
  // callback won the claim — a duplicate callback can no longer re-send.
  if (result.kind === 'broadcast' && result.action === 'paid') {
    await triggerBroadcastFanOut(result.id)
  }

  return NextResponse.json({ ok: true })
}

// Fire-and-await the fan-out. We're already in a background webhook, so
// blocking until WhatsApp finishes is fine and keeps audit ordering
// deterministic.
//
// The send route requires Authorization: Bearer <INTERNAL_API_SECRET> (it is
// the only bulk-WhatsApp emitter in the app). This is its one legitimate
// caller.
//
// RECOVERY NOTE for every failure path below: the broadcast has ALREADY been
// marked paid, so a failed send leaves it at status='paid', which is exactly
// the state /send requires. Nothing is lost — fix the cause and re-POST the
// route to fan out.
async function triggerBroadcastFanOut(broadcastId: string): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://streetmenu.vercel.app'
  const internalSecret = process.env.INTERNAL_API_SECRET
  if (!internalSecret) {
    // Checked BEFORE the call so the log names the real cause. Calling
    // without it would come back 503 and read like the send route is
    // broken, when the actual fault is a missing env var here.
    console.error(
      `[payments/webhook] INTERNAL_API_SECRET is not set — CANNOT trigger the fan-out ` +
      `for broadcast=${broadcastId}. It is PAID and stuck at status=paid. Set ` +
      `INTERNAL_API_SECRET in Vercel (Production), redeploy, then ` +
      `POST /api/broadcasts/${broadcastId}/send with that bearer token to recover.`,
    )
    return
  }
  try {
    const sendRes = await fetch(`${baseUrl}/api/broadcasts/${broadcastId}/send`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${internalSecret}` },
    })
    // fetch does NOT throw on a non-2xx, so without this check a 401 or 503
    // would be swallowed and look like success.
    if (!sendRes.ok) {
      const detail = await sendRes.text().catch(() => '')
      console.error(
        `[payments/webhook] broadcast fan-out REFUSED: broadcast=${broadcastId} ` +
        `status=${sendRes.status} body=${detail.slice(0, 200)} — it is PAID and stuck ` +
        `at status=paid; re-POST /api/broadcasts/${broadcastId}/send once fixed.`,
      )
    }
  } catch (e) {
    console.error(
      `[payments/webhook] broadcast send failed: broadcast=${broadcastId} — ` +
      `${(e as Error).message} — it is PAID and stuck at status=paid; re-POST ` +
      `/api/broadcasts/${broadcastId}/send to recover.`,
    )
  }
}
