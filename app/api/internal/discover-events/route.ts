import { NextRequest, NextResponse } from 'next/server'
import { authorizeInternal } from '@/lib/internalAuth'
import { startRun, runStep } from '@/lib/discovery/run'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// POST /api/internal/discover-events  { "step": "start" | "step" | "report" }
// Nightly event discovery (lib/discovery/run.ts). Caller: Supabase pg_cron →
// pg_net (supabase-event-discovery.sql). AUTHORIZATION: Bearer
// <INTERNAL_API_SECRET> (lib/internalAuth.ts). Each step stays well under a
// minute; maxDuration is only a safety margin.
export async function POST(req: NextRequest) {
  const auth = authorizeInternal(req)
  if (!auth.ok) {
    console.error(`[discover-events] REFUSED (${auth.status}): ${auth.logLine}`)
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: auth.status })
  }
  const body = await req.json().catch(() => ({})) as { step?: string }
  try {
    if (body.step === 'start') return NextResponse.json({ ok: true, ...(await startRun()) })
    if (body.step === 'step') return NextResponse.json({ ok: true, ...(await runStep()) })
    if (body.step === 'report') return NextResponse.json({ ok: true, report: 'not_built' })
    return NextResponse.json({ error: 'step: start | step | report' }, { status: 400 })
  } catch (e) {
    console.error(`[discover-events] ${body.step} failed:`, (e as Error).message)
    return NextResponse.json({ ok: false, error: `${body.step} failed` }, { status: 500 })
  }
}
