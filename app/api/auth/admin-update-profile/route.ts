import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// POST { name } — update the logged-in admin's display name.
// Email and role are NEVER updatable here.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { name } = await req.json()
  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'Nom requis / Name required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('admin_users')
    .update({ name: name.trim() })
    .eq('id', session.id)
    .select('id, name, email, role, status, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })

  return NextResponse.json({ ok: true, profile: data })
}
