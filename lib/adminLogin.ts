// Team / admin login, two steps (supabase-admin-login-hardening.sql). Server only.
//
//   1. email + password  → a 6-digit code to the team member's phone
//      (admin_login_challenges — never the customer code table, so a
//      customer code can't open a team account even on the same number).
//   2. the code          → a 12-hour team session.
//
// Every attempt is logged (admin_login_attempts + audit_log). 5 failures in
// 15 min for one email or one IP lock both steps (admin_login_lock). When a
// lock starts, every super-admin with a phone gets a WhatsApp alert (at most
// one per email / IP per hour).

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp } from '@/lib/whatsapp'
import { sendSMS } from '@/lib/sms'
import { writeAudit } from '@/lib/audit'
import { generateCode, claimCodeSend, markCodeSendFailed } from '@/lib/authCodes'
import { formatPhoneDisplay } from '@/lib/phoneValidation'

export const ADMIN_CODE_TTL_MS = 10 * 60 * 1000
export const ADMIN_CODE_MAX_ATTEMPTS = 5

export function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.toLowerCase().trim().slice(0, 200) : ''
}

export async function adminLock(email: string, ip: string): Promise<{ locked: boolean; retryAfter: number }> {
  const { data, error } = await supabaseAdmin.rpc('admin_login_lock', { p_email: email, p_ip: ip })
  if (error || !data) {
    // Fail CLOSED: without the lock check, refuse rather than allow guessing.
    console.error('[admin-login] lock check failed:', error?.message)
    return { locked: true, retryAfter: 60 }
  }
  const d = data as { locked: boolean; retry_after?: number }
  return { locked: !!d.locked, retryAfter: Number(d.retry_after ?? 0) }
}

export interface AttemptInput {
  email: string
  ip: string
  userAgent: string | null
  adminId: string | null
  stage: 'password' | 'code'
  success: boolean
  reason?: string
}

// Logs the attempt (attempts table + audit log). On a failure that starts a
// lock, alerts the super-admins.
export async function recordAttempt(a: AttemptInput): Promise<void> {
  const ip = a.ip && a.ip !== 'unknown' ? a.ip : null
  const { data: row, error } = await supabaseAdmin.from('admin_login_attempts').insert({
    email: a.email, ip, admin_id: a.adminId, stage: a.stage, success: a.success,
    reason: a.reason ?? null, user_agent: a.userAgent?.slice(0, 200) ?? null,
  }).select('id').single()
  if (error) console.error('[admin-login] attempt log failed:', error.message)

  await writeAudit({
    // Password right but code still to come → its own action; only the code
    // step logs a login.
    action:          a.success ? (a.stage === 'code' ? 'admin_login_success' : 'admin_login_password_ok') : 'admin_login_failed',
    targetType:      'admin_user',
    targetId:        a.adminId ?? (row?.id as string) ?? '00000000-0000-0000-0000-000000000000',
    performedBy:     a.adminId,
    performedByType: 'admin_login',
    metadata:        { email: a.email, ip, stage: a.stage, reason: a.reason ?? null },
  })

  if (!a.success && a.reason !== 'locked') {
    const lock = await adminLock(a.email, a.ip)
    if (lock.locked) await alertSuperAdmins(a.email, ip)
  }
}

async function alertSuperAdmins(email: string, ip: string | null): Promise<void> {
  // The local test server runs with ADMIN_LOGIN_ALERTS=off: its lockout
  // test must not message (or log failed sends to) the real super-admins.
  if (process.env.ADMIN_LOGIN_ALERTS === 'off') return
  const every = 60
  const since = new Date(Date.now() - every * 60_000).toISOString()
  // One alert per email / IP per hour (the last alert is an audit row).
  const { data: recent } = await supabaseAdmin.from('audit_log')
    .select('metadata').eq('action', 'admin_login_alert').gte('created_at', since).range(0, 199)
  const already = (recent ?? []).some(r => {
    const m = r.metadata as { email?: string; ip?: string | null } | null
    return m?.email === email || (!!ip && m?.ip === ip)
  })
  if (already) return

  const { data: supers } = await supabaseAdmin.from('admin_users')
    .select('id, phone').eq('role', 'super_admin').eq('status', 'active').not('phone', 'is', null)
  const text =
    `⚠️ Tchop & Ndjoka — connexion équipe bloquée\n` +
    `5 tentatives échouées sur ${email}${ip ? ` depuis ${ip}` : ''}.\n` +
    `Bloqué 15 min. Si ce n'est pas vous, changez le mot de passe.\n\n` +
    `Team login locked: 5 failed attempts on ${email}${ip ? ` from ${ip}` : ''}.`
  for (const s of supers ?? []) {
    await sendWhatsApp(s.phone as string, text, { context: 'account_notice' }).catch(() => null)
  }
  await writeAudit({
    action: 'admin_login_alert', targetType: 'admin_user',
    targetId: (supers?.[0]?.id as string) ?? '00000000-0000-0000-0000-000000000000',
    performedByType: 'system', metadata: { email, ip, notified: (supers ?? []).length },
  })
}

export type SendCodeOutcome =
  | { ok: true; challengeId: string; channel: 'whatsapp' | 'sms'; maskedPhone: string }
  | { ok: false; status: number; error: string; retryAfter?: number }

function maskPhone(phone: string): string {
  const shown = formatPhoneDisplay(phone) || phone
  return shown.replace(/\d(?=(?:\D*\d){2})/g, '•')
}

// A new challenge (older unused ones die) and its code to the admin's phone.
// Team codes keep the per-number / per-IP limits but skip the daily cap.
export async function sendAdminCode(admin: { id: string; phone: string }, ip: string): Promise<SendCodeOutcome> {
  const claim = await claimCodeSend(admin.phone, ip, 'whatsapp', false, 'team')
  if (!claim.ok) {
    return {
      ok: false, status: claim.reason === 'error' ? 500 : 429, retryAfter: claim.retryAfter,
      error: claim.reason === 'resend_cooldown'
        ? `Patientez ${claim.retryAfter} s avant de redemander un code. / Wait ${claim.retryAfter} s before asking again.`
        : 'Trop de codes demandés. Réessayez plus tard. / Too many codes requested. Try again later.',
    }
  }

  const code = generateCode()
  await supabaseAdmin.from('admin_login_challenges').update({ used: true }).eq('admin_id', admin.id).eq('used', false)
  const { data: ch, error } = await supabaseAdmin.from('admin_login_challenges').insert({
    admin_id: admin.id, code, expires_at: new Date(Date.now() + ADMIN_CODE_TTL_MS).toISOString(),
    ip: ip && ip !== 'unknown' ? ip : null,
  }).select('id').single()
  if (error || !ch) {
    console.error('[admin-login] challenge insert failed:', error?.message)
    await markCodeSendFailed(claim.sendId, 'challenge_insert_failed')
    return { ok: false, status: 500, error: 'Erreur — réessayez. / Error — please try again.' }
  }

  const msg = `Tchop & Ndjoka — équipe / team\nCode de connexion / Login code: ${code}`
  const wa = await sendWhatsApp(admin.phone, msg, { context: 'verification_code' })
  if (wa.ok) return { ok: true, challengeId: ch.id as string, channel: 'whatsapp', maskedPhone: maskPhone(admin.phone) }

  await markCodeSendFailed(claim.sendId, wa.errorCode ?? wa.error?.slice(0, 80) ?? `http_${wa.status}`)
  if (wa.errorCode !== '63038') {
    const fb = await claimCodeSend(admin.phone, ip, 'sms', true, 'team')
    if (fb.ok) {
      const s = await sendSMS(admin.phone, msg, { context: 'verification_code' })
      if (s.ok) return { ok: true, challengeId: ch.id as string, channel: 'sms', maskedPhone: maskPhone(admin.phone) }
      await markCodeSendFailed(fb.sendId, s.errorCode ?? s.error?.slice(0, 80) ?? `http_${s.status}`)
    }
  }
  return { ok: false, status: 502, error: 'Le code n\'a pas pu être envoyé. / The code could not be sent.' }
}

export type ChallengeCheck =
  | { ok: true; adminId: string }
  | { ok: false; reason: 'bad_code' | 'code_expired' | 'code_locked'; adminId: string | null; attemptsLeft?: number }

export async function checkChallenge(challengeId: string, code: string): Promise<ChallengeCheck> {
  const { data: ch } = await supabaseAdmin.from('admin_login_challenges')
    .select('id, admin_id, code, expires_at, attempts, used').eq('id', challengeId).maybeSingle()
  if (!ch || ch.used) return { ok: false, reason: 'code_expired', adminId: (ch?.admin_id as string) ?? null }
  if (new Date(ch.expires_at as string) < new Date()) return { ok: false, reason: 'code_expired', adminId: ch.admin_id as string }
  if ((ch.attempts as number) >= ADMIN_CODE_MAX_ATTEMPTS) return { ok: false, reason: 'code_locked', adminId: ch.admin_id as string }
  if (ch.code !== code) {
    const attempts = (ch.attempts as number) + 1
    await supabaseAdmin.from('admin_login_challenges').update({ attempts }).eq('id', ch.id)
    return { ok: false, reason: 'bad_code', adminId: ch.admin_id as string, attemptsLeft: Math.max(ADMIN_CODE_MAX_ATTEMPTS - attempts, 0) }
  }
  // Single use: only the update that flips used=false → true wins.
  const { data: claimed } = await supabaseAdmin.from('admin_login_challenges')
    .update({ used: true }).eq('id', ch.id).eq('used', false).select('id')
  if (!claimed || claimed.length === 0) return { ok: false, reason: 'code_expired', adminId: ch.admin_id as string }
  return { ok: true, adminId: ch.admin_id as string }
}
