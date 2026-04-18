import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { setSessionCookie, SessionPayload, SessionRole } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { email, password, rememberMe } = await req.json()
  console.log('[admin-login] received email =', JSON.stringify(email), '| password length =', password?.length ?? 0)

  if (!email || !password) {
    console.log('[admin-login] missing email or password')
    return NextResponse.json({ error: 'Email et mot de passe requis / Email and password required' }, { status: 400 })
  }

  const normalizedEmail = email.toLowerCase().trim()
  console.log('[admin-login] normalized email =', JSON.stringify(normalizedEmail))

  const { data: admin, error } = await supabaseAdmin
    .from('admin_users')
    .select('id, email, password_hash, name, role, status')
    .eq('email', normalizedEmail)
    .maybeSingle()

  console.log('[admin-login] supabase error =', error)
  console.log('[admin-login] admin row found =', !!admin, admin ? { id: admin.id, email: admin.email, role: admin.role, status: admin.status, hashPrefix: admin.password_hash?.slice(0, 4), hashLen: admin.password_hash?.length } : null)

  if (error || !admin) {
    return NextResponse.json({ error: 'Identifiants incorrects / Incorrect credentials' }, { status: 401 })
  }

  if (admin.status === 'suspended') {
    console.log('[admin-login] account suspended')
    return NextResponse.json({ error: 'Compte suspendu / Account suspended' }, { status: 403 })
  }

  const valid = await bcrypt.compare(password, admin.password_hash)
  console.log('[admin-login] bcrypt.compare result =', valid)
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
