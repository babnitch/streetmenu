import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { setAdminSession, verifyPasswordChangePass, type SessionPayload, type SessionRole } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { MIN_PASSWORD, PASSWORD_SHORT } from '@/lib/adminTeam'

export const dynamic = 'force-dynamic'

// POST /api/auth/admin-set-password — team login, step 3 when the password
// is temporary. Body: { pass, newPassword }. The pass comes from
// /api/auth/admin-verify (right password + right code, 10 min). The new
// password must differ from the temporary one; then the session opens.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const adminId = verifyPasswordChangePass(body?.pass)
  if (!adminId) {
    return NextResponse.json({ error: 'Délai dépassé. Reconnectez-vous. / Timed out. Log in again.', restart: true }, { status: 401 })
  }
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''
  if (newPassword.length < MIN_PASSWORD) return NextResponse.json({ error: PASSWORD_SHORT }, { status: 400 })

  const { data: admin } = await supabaseAdmin.from('admin_users')
    .select('id, email, name, role, status, password_hash, must_change_password').eq('id', adminId).maybeSingle()
  if (!admin || admin.status !== 'active') {
    return NextResponse.json({ error: 'Compte suspendu / Account suspended', restart: true }, { status: 403 })
  }
  if (!admin.must_change_password) {
    return NextResponse.json({ error: 'Mot de passe déjà changé. Reconnectez-vous. / Password already changed. Log in again.', restart: true }, { status: 409 })
  }
  if (await bcrypt.compare(newPassword, admin.password_hash as string)) {
    return NextResponse.json({ error: 'Choisissez un mot de passe différent du temporaire. / Choose a password different from the temporary one.' }, { status: 400 })
  }

  const { error } = await supabaseAdmin.from('admin_users')
    .update({ password_hash: await bcrypt.hash(newPassword, 12), must_change_password: false })
    .eq('id', admin.id).eq('must_change_password', true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await writeAudit({
    action: 'admin_user_password_set', targetType: 'admin_user', targetId: admin.id,
    performedBy: admin.id, performedByType: admin.role as string, metadata: { first_login: true },
  })

  const payload: SessionPayload = { id: admin.id, email: admin.email, name: admin.name, role: admin.role as SessionRole }
  const res = NextResponse.json({ ok: true, user: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } })
  return setAdminSession(res, payload)
}
