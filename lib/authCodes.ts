// Login codes (supabase-auth-login-limits.sql). Server only.
//
// Every limit lives in the database so it holds across Vercel servers:
//   auth_code_claim()  30 s between sends per phone, sends per phone per hour,
//                      per IP per hour, and a platform-wide cap per 24 h. Every
//                      attempt — sent, failed or blocked — is logged in
//                      auth_code_sends (Admin → Messages → Codes de connexion).
//   auth_code_check()  a code dies after the configured number of wrong tries.
// The limits are rows of platform_settings, changeable without a deploy.

import { randomInt } from 'crypto'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { pickLang, type Lang } from '@/lib/whatsapp'
import { normalizeTypedPhone, COUNTRIES, TYPED_PHONE_ERROR, type TypedPhoneResult } from '@/lib/phoneValidation'

export const CODE_LENGTH = 6
export const CODE_TTL_MS = 10 * 60 * 1000

export function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
}

// The login form sends a number with its country (ISO, default Cameroon);
// any typed shape is accepted and turned into +E.164.
export function normalizeLoginPhone(raw: unknown, countryIso: unknown): TypedPhoneResult {
  const iso = typeof countryIso === 'string' && COUNTRIES[countryIso.toUpperCase()] ? countryIso.toUpperCase() : 'CM'
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: TYPED_PHONE_ERROR }
  return normalizeTypedPhone(raw, COUNTRIES[iso])
}

export type ClaimReason = 'resend_cooldown' | 'phone_hourly' | 'ip_hourly' | 'daily_cap'
export type ClaimResult =
  | { ok: true; sendId: string }
  | { ok: false; reason: ClaimReason | 'error'; retryAfter: number }

// purpose 'team': admin login codes — same per-number / per-IP limits, but
// outside the platform's daily cap (supabase-admin-login-hardening.sql).
export async function claimCodeSend(
  phone: string, ip: string, channel: 'whatsapp' | 'sms', fallback = false, purpose: 'customer' | 'team' = 'customer',
): Promise<ClaimResult> {
  const { data, error } = await supabaseAdmin.rpc('auth_code_claim', {
    p_phone: phone, p_ip: ip, p_channel: channel, p_fallback: fallback, p_purpose: purpose,
  })
  if (error || !data) {
    console.error('[auth-codes] claim failed:', error?.message)
    return { ok: false, reason: 'error', retryAfter: 60 }
  }
  const d = data as { ok: boolean; send_id?: string; reason?: ClaimReason; retry_after?: number }
  return d.ok
    ? { ok: true, sendId: d.send_id as string }
    : { ok: false, reason: d.reason ?? 'error', retryAfter: Number(d.retry_after ?? 60) }
}

// The provider refused the message: keep the attempt counted, record why.
export async function markCodeSendFailed(sendId: string, reason: string): Promise<void> {
  const { error } = await supabaseAdmin.from('auth_code_sends')
    .update({ status: 'failed', reason: reason.slice(0, 120) }).eq('id', sendId)
  if (error) console.error('[auth-codes] mark failed:', error.message)
}

export type CheckResult =
  | { result: 'ok' }
  | { result: 'wrong'; attemptsLeft: number }
  | { result: 'expired' | 'locked' | 'none' }

export async function checkCode(phone: string, code: string): Promise<CheckResult | null> {
  const { data, error } = await supabaseAdmin.rpc('auth_code_check', { p_phone: phone, p_code: code })
  if (error || !data) {
    console.error('[auth-codes] check failed:', error?.message)
    return null
  }
  const d = data as { result: CheckResult['result']; attempts_left?: number }
  return d.result === 'wrong' ? { result: 'wrong', attemptsLeft: Number(d.attempts_left ?? 0) } : { result: d.result } as CheckResult
}

function wait(seconds: number, lang: Lang): string {
  if (seconds < 90) return pickLang(`${seconds} s`, `${seconds} s`, lang)
  const min = Math.ceil(seconds / 60)
  if (min < 90) return `${min} min`
  const h = Math.ceil(min / 60)
  return pickLang(`${h} h`, `${h} h`, lang)
}

// One language: the site's, sent by the login form (FR by default).
export function claimRefusalText(reason: ClaimReason | 'error', retryAfter: number, lang: Lang): string {
  switch (reason) {
    case 'resend_cooldown':
      return pickLang(`Patientez ${wait(retryAfter, lang)} avant de redemander un code.`, `Please wait ${wait(retryAfter, lang)} before asking for a new code.`, lang)
    case 'phone_hourly':
    case 'ip_hourly':
      return pickLang(`Trop de codes demandés. Réessayez dans ${wait(retryAfter, lang)}.`, `Too many codes requested. Try again in ${wait(retryAfter, lang)}.`, lang)
    case 'daily_cap':
      return pickLang('Connexion momentanément indisponible. Réessayez plus tard.', 'Login is temporarily unavailable. Please try again later.', lang)
    default:
      return pickLang('Erreur — réessayez.', 'Error — please try again.', lang)
  }
}

export function checkRefusalText(r: Exclude<CheckResult, { result: 'ok' }>, lang: Lang): string {
  switch (r.result) {
    case 'wrong':
      return r.attemptsLeft > 0
        ? pickLang(`Code incorrect. Encore ${r.attemptsLeft} essai(s).`, `Incorrect code. ${r.attemptsLeft} attempt(s) left.`, lang)
        : pickLang('Code incorrect. Demandez un nouveau code.', 'Incorrect code. Ask for a new code.', lang)
    case 'locked':
      return pickLang('Trop d\'essais. Demandez un nouveau code.', 'Too many attempts. Ask for a new code.', lang)
    case 'expired':
      return pickLang('Code expiré. Demandez un nouveau code.', 'Code expired. Ask for a new code.', lang)
    default:
      return pickLang('Demandez d\'abord un code.', 'Ask for a code first.', lang)
  }
}

export const SUSPENDED_TEXT = (lang: Lang) => pickLang(
  'Ce compte est suspendu. Contactez le support.',
  'This account is suspended. Please contact support.',
  lang,
)
