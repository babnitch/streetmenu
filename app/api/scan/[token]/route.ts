import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rateLimit'
import { resolveScanToken } from '@/lib/scanTokens'
import { loadScan, redeemScan } from '@/lib/scanCheck'

export const dynamic = 'force-dynamic'

// /api/scan/<token> (Q2)
// GET   what the QR is, for this viewer — NEVER changes anything (WhatsApp
//       and browsers pre-open links). Staff see the item and the button;
//       the owner sees their own item; anyone else a neutral answer.
// POST  { via?: 'scan' | 'code', restaurant_id? } — the button: check in /
//       hand over / redeem, once (atomic). Staff only.
// Rate limited per IP and per account.

// A logged-in scanner: 120 a minute (a busy door: one look + one press per
// ticket). Logged out: 60 a minute per IP.
function limited(req: NextRequest, sessionId: string | null): NextResponse | null {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local'
  const hit = sessionId
    ? rateLimit({ key: `scan:user:${sessionId}`, max: 120, windowMs: 60_000 })
    : rateLimit({ key: `scan:ip:${ip}`, max: 60, windowMs: 60_000 })
  if (hit) return NextResponse.json({ error: hit.message }, { status: 429, headers: { 'Retry-After': String(hit.retryAfterSec) } })
  return null
}

const NOT_FOUND = { access: 'none', state: 'refused', reason: 'QR inconnu ou remplacé / Unknown or replaced QR' }

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const session = getSessionFromRequest(req)
  const lim = limited(req, session?.id ?? null)
  if (lim) return lim
  const target = await resolveScanToken(params.token)
  if (!target) return NextResponse.json(NOT_FOUND, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const view = await loadScan(target.kind, target.id, session)
  return NextResponse.json({ ...view, loggedIn: !!session }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  const lim = limited(req, session.id)
  if (lim) return lim
  const target = await resolveScanToken(params.token)
  if (!target) return NextResponse.json(NOT_FOUND, { status: 404 })
  const body = await req.json().catch(() => ({})) as { via?: unknown; restaurant_id?: unknown; code?: unknown }
  const r = await redeemScan(target.kind, target.id, session, {
    via: body.via === 'code' ? 'code' : 'scan',
    restaurantId: typeof body.restaurant_id === 'string' ? body.restaurant_id : undefined,
    code: typeof body.code === 'string' ? body.code : undefined,
  })
  return NextResponse.json({ ok: r.ok, ...r.view }, { status: r.ok ? 200 : r.status, headers: { 'Cache-Control': 'no-store' } })
}
