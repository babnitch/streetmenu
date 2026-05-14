// Nickname validation + cooldown rules.
//
// Comments in /events/[id] sign the author with this nickname instead of
// their phone number. Constraints: 3-20 chars, alphanumeric + underscore
// + dot + dash (no spaces — keeps display tight), and explicitly rejects
// anything that looks like a phone number (4+ consecutive digits) so a
// well-meaning user doesn't accidentally publish their MoMo number.

const NICKNAME_LEN_MIN = 3
const NICKNAME_LEN_MAX = 20
const NICKNAME_ALLOWED = /^[A-Za-z0-9._-]+$/
const PHONE_LIKE       = /\d{4,}/        // 4+ consecutive digits = looks like a phone
const COOLDOWN_DAYS    = 30

export type NicknameRejectReason = 'too_short' | 'too_long' | 'invalid_chars' | 'phone_like' | 'cooldown'

export function validateNickname(raw: string): { ok: true; value: string } | { ok: false; reason: NicknameRejectReason } {
  const value = (raw ?? '').trim()
  if (value.length < NICKNAME_LEN_MIN) return { ok: false, reason: 'too_short' }
  if (value.length > NICKNAME_LEN_MAX) return { ok: false, reason: 'too_long' }
  if (!NICKNAME_ALLOWED.test(value))   return { ok: false, reason: 'invalid_chars' }
  if (PHONE_LIKE.test(value))          return { ok: false, reason: 'phone_like' }
  return { ok: true, value }
}

// Returns days remaining in the cooldown window, or 0 when ready to change.
export function nicknameCooldownDaysRemaining(updatedAt: string | null | undefined): number {
  if (!updatedAt) return 0
  const ms = Date.now() - new Date(updatedAt).getTime()
  const dayMs = 24 * 60 * 60 * 1000
  const remaining = Math.ceil((COOLDOWN_DAYS * dayMs - ms) / dayMs)
  return Math.max(0, remaining)
}

export const NICKNAME_REJECT_MESSAGES: Record<NicknameRejectReason, string> = {
  too_short:     'Pseudo trop court (min. 3) / Nickname too short',
  too_long:      'Pseudo trop long (max. 20) / Nickname too long',
  invalid_chars: 'Lettres, chiffres, _ . - uniquement / Letters, digits, _ . - only',
  phone_like:    'Évitez les numéros de téléphone / Avoid phone numbers',
  cooldown:      'Changement déjà effectué récemment / Already changed recently',
}

// Public display fallback when a customer commented before setting a
// nickname. Won't be hit for new comments — POST /comments enforces a
// nickname — but historical rows may pre-exist this column.
export function displayNickname(c: { nickname: string | null; name: string | null }): string {
  if (c.nickname && c.nickname.trim()) return c.nickname
  const first = (c.name ?? '').trim().split(/\s+/)[0]
  return first || 'Anonyme'
}
