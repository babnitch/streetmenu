import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { TEAM_ROLES, MIN_PASSWORD, teamPhone, PHONE_REQUIRED, PASSWORD_SHORT } from '@/lib/adminTeam'

export const dynamic = 'force-dynamic'

const COLUMNS = 'id, email, name, role, status, phone, must_change_password, created_at'

// GET: list platform team members (super_admin only)
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'super_admin') {
    return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  }
  const { data: team } = await supabaseAdmin.from('admin_users').select(COLUMNS).order('created_at')
  return NextResponse.json({ team: team ?? [] })
}

// POST: create an admin / moderator (super_admin only).
// Body: { name, email, password, role, phone } — phone required (the login
// code goes there). The password is temporary: changed at first login.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'super_admin') {
    return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const role = String(body.role ?? '')
  if (!name || !email || !password || !(TEAM_ROLES as readonly string[]).includes(role)) {
    return NextResponse.json({ error: 'Nom, email, mot de passe et rôle requis / Name, email, password, and role required' }, { status: 400 })
  }
  if (password.length < MIN_PASSWORD) return NextResponse.json({ error: PASSWORD_SHORT, field: 'password' }, { status: 400 })
  const phone = teamPhone(body.phone)
  if (!phone) return NextResponse.json({ error: PHONE_REQUIRED, field: 'phone' }, { status: 400 })

  const { data, error } = await supabaseAdmin
    .from('admin_users')
    .insert({
      name, email, phone, role,
      password_hash: await bcrypt.hash(password, 12),
      must_change_password: true,
      created_by: session.id,
    })
    .select(COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      const { data: taken } = await supabaseAdmin.from('admin_users').select('status').eq('email', email).maybeSingle()
      return NextResponse.json({ error: taken?.status === 'removed'
        ? 'Email d\'un membre retiré — utilisez un autre email / Email of a removed member — use another email'
        : 'Email déjà utilisé / Email already in use' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await writeAudit({
    action: 'admin_user_added',
    targetType: 'admin_user',
    targetId: data.id,
    performedBy: session.id,
    performedByType: session.role,
    metadata: { email: data.email, name: data.name, role: data.role, phone: data.phone },
  })

  return NextResponse.json({ ok: true, member: data })
}
