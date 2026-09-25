import { NextRequest, NextResponse } from 'next/server'
import { authorizeInternal } from '@/lib/internalAuth'
import { runReconcile, liveReconcileDeps } from '@/lib/payments-reconcile'

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

  try {
    const summary = await runReconcile(liveReconcileDeps)
    return NextResponse.json({ ok: true, ...summary })
  } catch (e) {
    console.error('[reconcile] run failed:', (e as Error).message)
    return NextResponse.json({ ok: false, error: 'reconcile failed' }, { status: 500 })
  }
}
