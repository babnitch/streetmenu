import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { getPlatformStatus, setSide } from '@/lib/platformSwitch'

export const dynamic = 'force-dynamic'

// Platform switches (M6). super_admin / admin only, audited.
// GET → { restaurants, events }
// PUT { restaurants?: boolean, events?: boolean }
function admin(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && ['super_admin', 'admin'].includes(s.role) ? s : null
}

export async function GET(req: NextRequest) {
  if (!admin(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  return NextResponse.json(await getPlatformStatus(), { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(req: NextRequest) {
  const s = admin(req)
  if (!s) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const changes = (['restaurants', 'events'] as const).filter(k => typeof body?.[k] === 'boolean')
  if (changes.length === 0) return NextResponse.json({ error: 'restaurants / events (boolean)' }, { status: 400 })
  try {
    for (const k of changes) await setSide(k, body[k], { id: s.id, type: s.role })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, ...(await getPlatformStatus()) })
}
