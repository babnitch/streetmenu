import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// GET /api/admin/login-attempts — Admin → Comptes → "Connexions de l'équipe":
// the latest 100 team login attempts (success and failure, with IP and
// reason) and how many failures in the last 24 h. super_admin / admin only.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const [rows, fails] = await Promise.all([
    supabaseAdmin.from('admin_login_attempts')
      .select('id, email, ip, stage, success, reason, created_at')
      .order('created_at', { ascending: false }).range(0, 99),
    supabaseAdmin.from('admin_login_attempts')
      .select('id', { count: 'exact', head: true }).eq('success', false).gte('created_at', since),
  ])
  if (rows.error) {
    console.error('[admin/login-attempts] read failed:', rows.error.message)
    return NextResponse.json({ error: rows.error.message }, { status: 500 })
  }
  return NextResponse.json({ attempts: rows.data ?? [], failures24h: fails.count ?? 0 })
}
