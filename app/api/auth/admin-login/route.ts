import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { clientIP } from '@/lib/rateLimit'
import { signCodeTicket } from '@/lib/auth'
import { normalizeEmail, adminLock, recordAttempt, sendAdminCode } from '@/lib/adminLogin'

export const dynamic = 'force-dynamic'

// Compared against when the email is unknown, so a wrong email takes as long
// as a wrong password (no telling which emails exist from the timing). A real
// bcrypt hash of a random string, made once per server.
let dummyHash: string | null = null
function getDummyHash(): string {
  if (!dummyHash) dummyHash = bcrypt.hashSync(crypto.randomUUID(), 10)
  return dummyHash
}

const BAD = 'Identifiants incorrects / Incorrect credentials'

function lockedText(retryAfter: number): string {
  const min = Math.max(1, Math.ceil(retryAfter / 60))
  return `Connexion bloquée. Réessayez dans ${min} min. / Login locked. Try again in ${min} min.`
}

// POST /api/auth/admin-login — team login, STEP 1 of 2.
// Body: { email, password }
// Right password → a 6-digit code to the team member's phone and
// { step: 'code', challenge, channel, sentTo } (masked). The session only
// comes with the code (/api/auth/admin-verify).
// 5 failures in 15 min per email or per IP → locked (database). Errors never
// say whether the email exists.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const email = normalizeEmail(body?.email)
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!email || !password) {
    return NextResponse.json({ error: 'Email et mot de passe requis / Email and password required' }, { status: 400 })
  }
  const ip = clientIP(req)
  const userAgent = req.headers.get('user-agent')
  const base = { email, ip, userAgent, stage: 'password' as const }

  const lock = await adminLock(email, ip)
  if (lock.locked) {
    await recordAttempt({ ...base, adminId: null, success: false, reason: 'locked' })
    return NextResponse.json({ error: lockedText(lock.retryAfter), locked: true }, { status: 429 })
  }

  const { data: admin } = await supabaseAdmin
    .from('admin_users')
    .select('id, email, password_hash, name, role, status, phone')
    .eq('email', email)
    .maybeSingle()

  const valid = await bcrypt.compare(password, admin?.password_hash ?? getDummyHash())
  if (!admin || !valid) {
    await recordAttempt({ ...base, adminId: admin?.id ?? null, success: false, reason: admin ? 'bad_password' : 'unknown_email' })
    return NextResponse.json({ error: BAD }, { status: 401 })
  }

  // The password is proven from here on, so the precise reason can be told.
  if (admin.status === 'suspended') {
    await recordAttempt({ ...base, adminId: admin.id, success: false, reason: 'suspended' })
    return NextResponse.json({ error: 'Compte suspendu / Account suspended' }, { status: 403 })
  }
  if (!admin.phone) {
    await recordAttempt({ ...base, adminId: admin.id, success: false, reason: 'no_phone' })
    return NextResponse.json({
      error: 'Aucun numéro configuré pour ce compte — contactez un super-admin. / No phone set for this account — contact a super-admin.',
    }, { status: 403 })
  }

  await recordAttempt({ ...base, adminId: admin.id, success: true })
  const sent = await sendAdminCode({ id: admin.id, phone: admin.phone }, ip)
  if (!sent.ok) {
    return NextResponse.json({ error: sent.error, retry_after: sent.retryAfter }, { status: sent.status })
  }
  return NextResponse.json({ step: 'code', challenge: sent.challengeId, channel: sent.channel, sentTo: sent.maskedPhone, ticket: signCodeTicket(admin.phone) })
}
