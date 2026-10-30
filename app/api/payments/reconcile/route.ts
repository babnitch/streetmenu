import { NextRequest, NextResponse } from 'next/server'
import { authorizeInternal } from '@/lib/internalAuth'
import { runReconcile, liveReconcileDeps } from '@/lib/payments-reconcile'
import { runMessageRetries } from '@/lib/messageRetry'
import { reconcileRefunds } from '@/lib/refunds'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/payments/reconcile
// Settles deposits still pending 10 min – 48 h after they started, by asking
// PawaPay directly — the safety net for lost or rejected callbacks, and the
// ONLY recovery path for WhatsApp payments (nothing polls those). Logic in
// lib/payments-reconcile.ts.
//
// Caller: Supabase pg_cron → pg_net every ~10 min. AUTHORIZATION: Bearer
// <INTERNAL_API_SECRET> (lib/internalAuth.ts). Never callable without it.
export async function POST(req: NextRequest) {
  const auth = authorizeInternal(req)
  if (!auth.ok) {
    console.error(`[reconcile] REFUSED (${auth.status}): ${auth.logLine}`)
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: auth.status })
  }

  // Same cron tick also re-sends queued WhatsApp notifications that Twilio
  // refused for a temporary reason (lib/messageRetry.ts). Run after the
  // reconcile, and independently: one failing must not block the other.
  let summary: Awaited<ReturnType<typeof runReconcile>> | null = null
  let reconcileError: string | null = null
  try {
    summary = await runReconcile(liveReconcileDeps)
  } catch (e) {
    reconcileError = (e as Error).message
    console.error('[reconcile] run failed:', reconcileError)
  }

  // R2: refunds still pending (lost callback) — same tick, independent.
  let refunds: Awaited<ReturnType<typeof reconcileRefunds>> | { error: string }
  try {
    refunds = await reconcileRefunds()
  } catch (e) {
    console.error('[reconcile] refunds failed:', (e as Error).message)
    refunds = { error: 'refund reconcile failed' }
  }

  let messageRetries: Awaited<ReturnType<typeof runMessageRetries>> | { error: string }
  try {
    messageRetries = await runMessageRetries()
  } catch (e) {
    console.error('[reconcile] message retries failed:', (e as Error).message)
    messageRetries = { error: 'message retries failed' }
  }

  if (reconcileError) {
    return NextResponse.json({ ok: false, error: 'reconcile failed', refunds, messageRetries }, { status: 500 })
  }
  return NextResponse.json({ ok: true, ...summary, refunds, messageRetries })
}
