import { NextRequest, NextResponse } from 'next/server'
import { checkDepositStatus } from '@/lib/pawapay'
import { settleDeposit } from '@/lib/payments-settle'

export const dynamic = 'force-dynamic'

// GET /api/payments/status/[depositId]
// Polled by the checkout flows every 3s. Returns a small JSON envelope and
// also settles the local row when PawaPay reports a terminal status — the
// webhook is the primary update path, but polling is a safety net for
// callbacks that are dropped or (once signatures are enforced) rejected.
//
// Settling is lib/payments-settle.ts, shared with the webhook and the
// reconcile job: an atomic pending→terminal claim, so whichever of the three
// gets there first notifies once and the others no-op. Safe to settle here
// because the status comes from PawaPay over an authenticated
// server-to-server call (checkDepositStatus), never from the caller.
//
// Broadcasts: settled paid but NOT fanned out from here (webhook-only) —
// settleDeposit logs that loudly.
export async function GET(_req: NextRequest, { params }: { params: { depositId: string } }) {
  const { depositId } = params
  if (!depositId) return NextResponse.json({ error: 'depositId required' }, { status: 400 })

  let info
  try {
    info = await checkDepositStatus(depositId)
  } catch (e) {
    console.error('[payments/status] check failed:', (e as Error).message)
    return NextResponse.json({ error: 'PawaPay unavailable' }, { status: 502 })
  }

  // A settle failure must not break the checkout's view of the payment — the
  // next tick, the webhook or the reconcile job will retry the write.
  try {
    const result = await settleDeposit(depositId, info, 'status_poll')
    console.log(
      `[payment] poll tick: deposit=${depositId} pawapay.status=${info.status} → ` +
      (result.kind === 'unknown' ? 'no matching row' : `${result.kind}=${result.id} ${result.action}`),
    )
  } catch (e) {
    console.error(`[payments/status] settle failed for deposit=${depositId}:`, (e as Error).message)
  }

  // Map PawaPay verbs to a simple lifecycle the client can switch on.
  const phase: 'pending' | 'paid' | 'failed' =
    info.status === 'COMPLETED' ? 'paid' :
    info.status === 'FAILED' || info.status === 'REJECTED' ? 'failed' :
    'pending'

  return NextResponse.json({
    ok:        true,
    depositId,
    phase,
    rawStatus: info.status,
    failureReason: info.failureReason,
  })
}
