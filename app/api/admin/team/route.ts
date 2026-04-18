import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// GET: list platform team members (super_admin only)
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'super_admin') {
    return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  }

  const { data: team } = await supabaseAdmin
    .from('admin_users')
    .select('id, email, name, role, status, created_at')
    .order('created_at')

  return NextResponse.json({ team: team ?? [] })
}

// POST: create new admin/moderator (super_admin only)
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'super_admin') {
    return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  }

  const { name, email, password, role } = await req.json()
  if (!name || !email || !password || !['admin', 'moderator'].includes(role)) {
    return NextResponse.json({ error: 'Nom, email, mot de passe et rôle requis / Name, email, password, and role required' }, { status: 400 })
  }

  const passwordHash = await bcrypt.hash(password, 12)

  const { data, error } = await supabaseAdmin
    .from('admin_users')
    .insert({
      name,
      email: email.toLowerCase().trim(),
      password_hash: passwordHash,
      role,
      created_by: session.id,
    })
    .select('id, email, name, role, status, created_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Email déjà utilisé / Email already in use' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await writeAudit({
    action: 'admin_user_added',
    targetType: 'admin_user',
    targetId: data.id,
    performedBy: session.id,
    performedByType: session.role,
    metadata: { email: data.email, name: data.name, role: data.role },
  })

  return NextResponse.json({ ok: true, member: data })
}
