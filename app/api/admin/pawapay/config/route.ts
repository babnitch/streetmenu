import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { getActiveConfiguration, pawapayEnvironmentLabel } from '@/lib/pawapay'

export const dynamic = 'force-dynamic'

// GET /api/admin/pawapay/config (R1) — read-only: PawaPay's active
// configuration for Cameroon (operators, deposits / payouts / refunds, min,
// max, decimals). Super admin only. Cached 10 min per server instance.
let cache: { at: number; body: unknown } | null = null
const TTL_MS = 10 * 60 * 1000

export async function GET(req: NextRequest) {
  const s = getSessionFromRequest(req)
  if (!s || s.role !== 'super_admin') return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  const fresh = req.nextUrl.searchParams.get('refresh') === '1'
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.body)
  try {
    const r = await getActiveConfiguration('CMR')
    if (!r.ok) return NextResponse.json({ error: r.error, environment: pawapayEnvironmentLabel() }, { status: 502 })
    const body = { environment: pawapayEnvironmentLabel(), country: 'CMR', fetched_at: new Date().toISOString(), operators: r.operators }
    cache = { at: Date.now(), body }
    return NextResponse.json(body)
  } catch (e) {
    return NextResponse.json({ error: `PawaPay: ${(e as Error).message}`, environment: pawapayEnvironmentLabel() }, { status: 502 })
  }
}
