import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { setAdminSession, signPasswordChangePass, type SessionPayload, type SessionRole } from '@/lib/auth'
import { clientIP } from '@/lib/rateLimit'
import { sanitizeText } from '@/lib/sanitize'
import { adminLock, recordAttempt, checkChallenge } from '@/lib/adminLogin'

export const dynamic = 'force-dynamic'

// POST /api/auth/admin-verify — team login, STEP 2 of 2.
// Body: { challenge, code }
// The right code (single use, 10 min, 5 tries) → a 12-hour team session
// (or, with a temporary password, { step: 'set_password', pass }).
// Wrong codes count toward the same lock as wrong passwords.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const challenge = typeof body?.challenge === 'string' ? body.challenge : ''
  const code = sanitizeText(body?.code, 12).replace(/\D/g, '')
  if (!/^[0-9a-f-]{36}$/i.test(challenge) || code.length !== 6) {
    return NextResponse.json({ error: 'Saisissez le code à 6 chiffres. / Enter the 6-digit code.' }, { status: 400 })
  }
  const ip = clientIP(req)
  const userAgent = req.headers.get('user-agent')

  const { data: ch } = await supabaseAdmin.from('admin_login_challenges')
    .select('admin_id, admin_users!admin_login_challenges_admin_id_fkey(email)').eq('id', challenge).maybeSingle()
  const email = ((ch?.admin_users as unknown as { email?: string } | null)?.email ?? '').toLowerCase()
  if (!ch || !email) {
    return NextResponse.json({ error: 'Code expiré. Recommencez. / Code expired. Start again.', restart: true }, { status: 400 })
  }
  const base = { email, ip, userAgent, stage: 'code' as const }

  const lock = await adminLock(email, ip)
  if (lock.locked) {
    await recordAttempt({ ...base, adminId: ch.admin_id as string, success: false, reason: 'locked' })
    const min = Math.max(1, Math.ceil(lock.retryAfter / 60))
    return NextResponse.json({ error: `Connexion bloquée. Réessayez dans ${min} min. / Login locked. Try again in ${min} min.`, locked: true }, { status: 429 })
  }

  const r = await checkChallenge(challenge, code)
  if (!r.ok) {
    await recordAttempt({ ...base, adminId: r.adminId, success: false, reason: r.reason })
    const error = r.reason === 'bad_code'
      ? `Code incorrect. Encore ${r.attemptsLeft} essai(s). / Incorrect code. ${r.attemptsLeft} attempt(s) left.`
      : 'Code expiré ou trop d\'essais. Recommencez. / Code expired or too many attempts. Start again.'
    return NextResponse.json({ error, restart: r.reason !== 'bad_code' }, { status: 400 })
  }

  const { data: admin } = await supabaseAdmin.from('admin_users')
    .select('id, email, name, role, status, must_change_password').eq('id', r.adminId).maybeSingle()
  if (!admin || admin.status !== 'active') {
    await recordAttempt({ ...base, adminId: r.adminId, success: false, reason: 'suspended' })
    return NextResponse.json({ error: 'Compte suspendu / Account suspended' }, { status: 403 })
  }

  await recordAttempt({ ...base, adminId: admin.id, success: true })
  // A temporary password (new member, or reset by a super admin): no session
  // yet — a 10-min pass that only lets them choose their own password
  // (/api/auth/admin-set-password), which then opens the session.
  if (admin.must_change_password) {
    return NextResponse.json({ step: 'set_password', pass: signPasswordChangePass(admin.id) })
  }
  const payload: SessionPayload = { id: admin.id, email: admin.email, name: admin.name, role: admin.role as SessionRole }
  const res = NextResponse.json({ ok: true, user: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } })
  return setAdminSession(res, payload)
}
