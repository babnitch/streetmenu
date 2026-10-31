import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { isTeamOrAdmin } from '@/lib/teamAccess'

export const dynamic = 'force-dynamic'

// GET /api/restaurants/[id]/orders — the pro dashboard's order list, newest
// first. The dashboard used to read orders in the browser with the public
// key, which meant anyone could read every order; orders are now
// server-only. Team (any role), implicit owner, admins.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  if (!(await isTeamOrAdmin(session, params.id))) return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
  const { data, error } = await supabaseAdmin.from('orders').select('*')
    .eq('restaurant_id', params.id).order('created_at', { ascending: false }).limit(1000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ orders: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}
