import { NextRequest, NextResponse } from 'next/server'
import { verifyPawaPayCallback, logCallbackVerification, shouldRejectCallback } from '@/lib/pawapay'
import { settleRefund } from '@/lib/refunds'

export const dynamic = 'force-dynamic'

// POST /api/payments/refund-webhook — PawaPay's REFUND callback (set as the
// "Refunds" callback URL in the PawaPay dashboard).
// Body: { refundId, status: 'COMPLETED' | 'FAILED', depositId, amount,
//         failureReason?: { failureCode, failureMessage } }
// Same signature check as the deposit webhook (log-only rollout, see
// lib/pawapay.ts). Settling is lib/refunds.ts settleRefund — atomic, so a
// duplicate callback, the admin's screen and the cron can't double-apply.
export async function POST(req: NextRequest) {
  const rawBytes = Buffer.from(await req.arrayBuffer())
  const rawBody = rawBytes.toString('utf8')
  const headers: Record<string, string> = {}
  req.headers.forEach((value, name) => { headers[name.toLowerCase()] = value })
  const internal = new URL(req.url)
  const host  = headers['x-forwarded-host'] ?? headers['host'] ?? internal.host
  const proto = headers['x-forwarded-proto'] ?? internal.protocol.replace(':', '')
  const url   = `${proto}://${host}${internal.pathname}${internal.search}`

  const verification = await verifyPawaPayCallback({ method: req.method, url, headers, rawBody: rawBytes })
  logCallbackVerification(verification, `url=${url}`)
  if (shouldRejectCallback(verification)) return NextResponse.json({ error: 'invalid signature' }, { status: 401 })

  let payload: { refundId?: string; status?: string; failureReason?: { failureMessage?: string; failureCode?: string } }
  try { payload = JSON.parse(rawBody) } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }
  const refundId = payload.refundId
  if (!refundId || !/^[0-9a-f-]{36}$/i.test(refundId)) return NextResponse.json({ error: 'no refundId' }, { status: 400 })

  const r = await settleRefund(refundId, {
    status: payload.status ?? '',
    failureReason: payload.failureReason?.failureMessage ?? payload.failureReason?.failureCode ?? null,
  }, 'webhook')
  if (r.action === 'unknown') console.warn(`[refund-webhook] no refund matches refundId=${refundId}`)
  return NextResponse.json({ ok: true, action: r.action })
}
