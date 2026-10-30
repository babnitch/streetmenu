import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { isTeamOrAdmin } from '@/lib/teamAccess'
import { ordersAwaitingCode } from '@/lib/protectedPayments'

export const dynamic = 'force-dynamic'

// GET /api/restaurants/[id]/awaiting-code — protected orders whose money is
// held until the customer's code is typed (Valider → "En attente du code").
// The restaurant's team or an admin.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  if (!(await isTeamOrAdmin(session, params.id))) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  return NextResponse.json({ orders: await ordersAwaitingCode(params.id) }, { headers: { 'Cache-Control': 'no-store' } })
}
