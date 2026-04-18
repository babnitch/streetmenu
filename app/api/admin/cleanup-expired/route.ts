import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { releaseExpiredAccounts } from '@/lib/releaseAccount'

export const dynamic = 'force-dynamic'

async function runCleanup(req: NextRequest): Promise<NextResponse> {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  const authHeader = req.headers.get('authorization')
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`

  if (!isCron) {
    const session = getSessionFromRequest(req)
    if (!session || session.role !== 'super_admin') {
      return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }
  }

  const released = await releaseExpiredAccounts()

  return NextResponse.json({
    ok: true,
    released,
    message: `${released} compte(s) anonymisé(s) / ${released} account(s) anonymized`,
  })
}

// GET — called by Vercel cron scheduler
export async function GET(req: NextRequest) { return runCleanup(req) }

// POST — manual trigger from admin dashboard
export async function POST(req: NextRequest) { return runCleanup(req) }
