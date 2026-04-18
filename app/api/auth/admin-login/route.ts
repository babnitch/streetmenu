import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { setSessionCookie, SessionPayload, SessionRole } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { email, password, rememberMe } = await req.json()

  if (!email || !password) {
    return NextResponse.json({ error: 'Email et mot de passe requis / Email and password required' }, { status: 400 })
  }

  const { data: admin, error } = await supabaseAdmin
    .from('admin_users')
    .select('id, email, password_hash, name, role, status')
    .eq('email', email.toLowerCase().trim())
    .maybeSingle()

  if (error || !admin) {
    return NextResponse.json({ error: 'Identifiants incorrects / Incorrect credentials' }, { status: 401 })
  }

  if (admin.status === 'suspended') {
    return NextResponse.json({ error: 'Compte suspendu / Account suspended' }, { status: 403 })
  }

  const valid = await bcrypt.compare(password, admin.password_hash)
  if (!valid) {
    return NextResponse.json({ error: 'Identifiants incorrects / Incorrect credentials' }, { status: 401 })
  }

  const payload: SessionPayload = {
    id:    admin.id,
    email: admin.email,
    name:  admin.name,
    role:  admin.role as SessionRole,
  }

  const res = NextResponse.json({
    ok:   true,
    user: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
  })
  return setSessionCookie(res, payload, Boolean(rememberMe))
}
