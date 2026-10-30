import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { getProtectedSettings, setProtectedSettings, isSandboxMoney, type ProtectedSettings } from '@/lib/protectedPayments'

export const dynamic = 'force-dynamic'

// Admin → Plateforme → "Paiements protégés" (super admin only, audited).
// GET → settings + sandbox; PUT { master?, acceptTimeoutMin?, autoReleaseHours?, codeMaxTries?, commissionOrderPct? }
function superAdmin(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && s.role === 'super_admin' ? s : null
}

export async function GET(req: NextRequest) {
  if (!superAdmin(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  return NextResponse.json({ settings: await getProtectedSettings(), sandbox: isSandboxMoney() }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(req: NextRequest) {
  const s = superAdmin(req)
  if (!s) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as Partial<ProtectedSettings>
  const patch: Partial<ProtectedSettings> = {}
  if (typeof body.master === 'boolean') patch.master = body.master
  for (const k of ['acceptTimeoutMin', 'autoReleaseHours', 'codeMaxTries', 'commissionOrderPct'] as const) {
    if (body[k] !== undefined) patch[k] = Number(body[k])
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Rien à changer / Nothing to change' }, { status: 400 })
  try {
    const settings = await setProtectedSettings(patch, { id: s.id, type: s.role })
    return NextResponse.json({ ok: true, settings, sandbox: isSandboxMoney() })
  } catch (e) {
    return NextResponse.json({ error: `Valeur invalide / Invalid value: ${(e as Error).message}` }, { status: 400 })
  }
}
