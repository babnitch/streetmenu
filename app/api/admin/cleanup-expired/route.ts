import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { releaseExpiredAccounts } from '@/lib/releaseAccount'
import { completeFinishedEvents } from '@/lib/eventLifecycle'

export const dynamic = 'force-dynamic'

async function runCleanup(req: NextRequest): Promise<NextResponse> {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  const authHeader = req.headers.get('authorization')
  // Only a SET secret counts (never "Bearer undefined").
  const secret = process.env.CRON_SECRET
  const isCron = !!secret && authHeader === `Bearer ${secret}`

  if (!isCron) {
    const session = getSessionFromRequest(req)
    if (!session || session.role !== 'super_admin') {
      return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }
  }

  const released = await releaseExpiredAccounts()
  // Events whose last day is over → 'completed' (never a cancelled one).
  let events: { completed: number } | { error: string }
  try { events = { completed: (await completeFinishedEvents()).completed } }
  catch (e) { console.error('[cleanup] event completion failed:', (e as Error).message); events = { error: 'event completion failed' } }

  return NextResponse.json({
    ok: true,
    released,
    events,
    message: `${released} compte(s) anonymisé(s) / ${released} account(s) anonymized`,
  })
}

// GET — called by Vercel cron scheduler
export async function GET(req: NextRequest) { return runCleanup(req) }

// POST — manual trigger from admin dashboard
export async function POST(req: NextRequest) { return runCleanup(req) }
