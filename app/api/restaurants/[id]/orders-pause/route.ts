import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { isManagerOrAdmin, ADMIN_ROLES } from '@/lib/teamAccess'
import { readOrdersPause, setOrdersPause } from '@/lib/ordersPauseServer'
import { PAUSE_CHOICES, type PauseChoice } from '@/lib/ordersPause'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/restaurants/[id]/orders-pause
//   Public: { available, paused, until } — the restaurant page and the
//   checkout read it (no cache, so a pause shows at once).
// POST /api/restaurants/[id]/orders-pause
//   Owner / manager / admin. Body { pause: '30m' | '1h' | 'closing' | 'manual' }
//   or { resume: true }. Audited (orders_paused / orders_resumed).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'id' }, { status: 400 })
  const s = await readOrdersPause(params.id)
  return NextResponse.json(
    { available: s.available, paused: s.paused, until: s.until },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'id' }, { status: 400 })
  if (!(await isManagerOrAdmin(session, params.id))) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({})) as { pause?: unknown; resume?: unknown }
  let pause: { choice: PauseChoice } | null
  if (body.resume === true) pause = null
  else if (typeof body.pause === 'string' && (PAUSE_CHOICES as readonly string[]).includes(body.pause)) pause = { choice: body.pause as PauseChoice }
  else return NextResponse.json({ error: 'pause: 30m | 1h | closing | manual, ou/or resume: true' }, { status: 400 })

  const r = await setOrdersPause(params.id, pause, {
    id: session.id, type: ADMIN_ROLES.includes(session.role) ? session.role : 'vendor', via: 'web',
  })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true, available: r.state.available, paused: r.state.paused, until: r.state.until })
}
