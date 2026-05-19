// Shared preparation-time helpers. Pure + client-safe (no server imports)
// so the card, detail page, order page, dashboard and WhatsApp layer can
// all format the range the same way: always "<min>-<max> min".

export const PREP_TIME_MIN_FLOOR = 5    // a 0-4 min kitchen isn't believable
export const PREP_TIME_MAX_CEIL  = 120  // 2h is the longest range we display
export const PREP_TIME_DEFAULT_MIN = 20 // matches the seed in supabase-prep-time.sql
export const PREP_TIME_DEFAULT_MAX = 35

// "20-35 min", or null when the restaurant hasn't set a range. Callers use
// the null to decide whether to render anything at all (cards/detail hide
// the badge entirely rather than showing an empty placeholder).
export function formatPrepTime(
  min?: number | null,
  max?: number | null,
): string | null {
  if (min == null || max == null) return null
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  return `${min}-${max} min`
}

export interface PrepTimeValidation {
  ok:   boolean
  min?: number
  max?: number
  error?: string  // bilingual FR / EN, ready to return to the client
}

// Validates a min/max pair against the spec rules:
//   min >= 5, max <= 120, min < max, both integers.
export function validatePrepTime(
  rawMin: unknown,
  rawMax: unknown,
): PrepTimeValidation {
  const min = Number(rawMin)
  const max = Number(rawMax)
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    return { ok: false, error: 'Minutes invalides / Invalid minutes' }
  }
  if (min < PREP_TIME_MIN_FLOOR) {
    return { ok: false, error: `Le minimum doit être ≥ ${PREP_TIME_MIN_FLOOR} min / Minimum must be ≥ ${PREP_TIME_MIN_FLOOR} min` }
  }
  if (max > PREP_TIME_MAX_CEIL) {
    return { ok: false, error: `Le maximum doit être ≤ ${PREP_TIME_MAX_CEIL} min / Maximum must be ≤ ${PREP_TIME_MAX_CEIL} min` }
  }
  if (min >= max) {
    return { ok: false, error: 'Le minimum doit être inférieur au maximum / Min must be less than max' }
  }
  return { ok: true, min, max }
}
