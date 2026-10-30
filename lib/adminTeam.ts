// Platform team (Admin → Équipe plateforme): the checks shared by the create
// and edit routes. A member's phone gets their 6-digit login code, so it is
// required and stored as +E.164 (admin_users_phone_format).

import { normalizePhone } from '@/lib/phone'

export const TEAM_ROLES = ['admin', 'moderator'] as const
export const TEAM_STATUSES = ['active', 'suspended'] as const
export const MIN_PASSWORD = 8

export function teamPhone(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const p = normalizePhone(raw.trim())
  return /^\+[0-9]{8,15}$/.test(p) ? p : null
}

export const PHONE_REQUIRED = 'Numéro WhatsApp valide requis (il reçoit le code de connexion) / Valid WhatsApp number required (it gets the login code)'
export const PASSWORD_SHORT = `Mot de passe : ${MIN_PASSWORD} caractères minimum / Password: at least ${MIN_PASSWORD} characters`
