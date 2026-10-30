import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { listProblems } from '@/lib/protectedPayments'

export const dynamic = 'force-dynamic'

// GET /api/admin/problems — Admin → Commandes → Problèmes (admins).
export async function GET(req: NextRequest) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  return NextResponse.json({ problems: await listProblems() }, { headers: { 'Cache-Control': 'no-store' } })
}
