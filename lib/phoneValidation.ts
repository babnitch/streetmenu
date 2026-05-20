// Phone helpers shared by the PhoneInput UI and server-side parsers.
//
// The full country dataset (~245 entries, bilingual names, flag emojis,
// dial codes) lives in lib/countriesData.ts. This module owns the
// typed exports, validation rules, and the dropdown sort/filter logic.
//
// Two validation tiers:
//   1. Platform countries (CM/CI/SN/TG/BJ) — strict length + prefix
//      check matching the PawaPay MNO routing in lib/pawapay.ts. Each
//      platform entry in countriesData carries localLength + prefixes
//      + placeholder + groupSizes.
//   2. Every other country — loose 6-15-digit length check (the E.164
//      envelope), no prefix list.

import { COUNTRIES_DATA, PLATFORM_ISO_SET, type CountryMeta } from './countriesData'
import type { Locale } from './translations'

export type CountryISO = string
export type { CountryMeta }

// Master list + indexed lookup. COUNTRIES_DATA is alphabetical by
// English name; the PhoneInput re-sorts per the user's locale at
// render time.
export const COUNTRY_LIST: CountryMeta[] = COUNTRIES_DATA
export const COUNTRIES: Record<string, CountryMeta> = Object.fromEntries(
  COUNTRY_LIST.map(c => [c.iso, c]),
)

export function isPlatformCountry(iso: string): boolean {
  return PLATFORM_ISO_SET.has(iso)
}

// City → default country. Cities outside the 5 platform countries
// fall back to CM (the platform's largest market). The user can
// always override via the dropdown.
const CITY_TO_COUNTRY: Record<string, CountryISO> = {
  'yaoundé': 'CM', 'yaounde': 'CM', 'douala': 'CM', 'bafoussam': 'CM',
  'abidjan': 'CI', 'bouaké': 'CI', 'bouake': 'CI', 'yamoussoukro': 'CI',
  'dakar': 'SN', 'thiès': 'SN', 'thies': 'SN', 'saint-louis': 'SN',
  'lomé': 'TG', 'lome': 'TG',
  'cotonou': 'BJ', 'porto-novo': 'BJ',
}

export function getCountryFromCity(city: string | null | undefined): CountryMeta {
  const key = (city ?? '').toLowerCase().trim()
  const iso = CITY_TO_COUNTRY[key] ?? 'CM'
  return COUNTRIES[iso] ?? COUNTRIES.CM
}

// Detect the country from an international phone (with or without '+').
// Longer dial codes are checked first so '+1242 Bahamas' isn't shadowed
// by '+1 USA / Canada' on a number that starts with 1242.
export function detectCountry(fullPhone: string | null | undefined): CountryMeta | null {
  if (!fullPhone) return null
  const digits = String(fullPhone).replace(/[^\d]/g, '')
  if (!digits) return null
  const candidates = [...COUNTRY_LIST].sort(
    (a, b) => b.dialCode.length - a.dialCode.length,
  )
  for (const meta of candidates) {
    if (digits.startsWith(meta.dialCode)) return meta
  }
  return null
}

export function splitIntoCountryAndLocal(
  fullPhone: string | null | undefined,
): { country: CountryMeta | null; local: string } {
  if (!fullPhone) return { country: null, local: '' }
  const digits = String(fullPhone).replace(/[^\d]/g, '')
  const country = detectCountry(digits)
  if (!country) return { country: null, local: digits }
  return {
    country,
    local: digits.slice(country.dialCode.length),
  }
}

function digitsOnly(s: string): string {
  return (s ?? '').replace(/\D/g, '')
}

export function formatLocalPhone(local: string, iso: CountryISO): string {
  const meta = COUNTRIES[iso]
  if (!meta) return local
  const d = digitsOnly(local)
  if (!d) return ''
  const parts: string[] = []
  let cursor = 0
  for (const size of meta.groupSizes) {
    if (cursor >= d.length) break
    parts.push(d.slice(cursor, cursor + size))
    cursor += size
  }
  if (cursor < d.length) parts.push(d.slice(cursor))
  return parts.join(' ')
}

export interface LocalPhoneValidation {
  ok:    boolean
  error?: string         // bilingual short reason for the UI
}

const LOOSE_MIN = 6
const LOOSE_MAX = 15

export function validateLocalPhone(local: string, iso: CountryISO): LocalPhoneValidation {
  const meta = COUNTRIES[iso]
  if (!meta) return { ok: false, error: 'Pays inconnu / Unknown country' }
  const d = digitsOnly(local)
  if (d.length === 0) return { ok: false, error: 'Numéro requis / Phone required' }

  // Loose validation for non-platform countries — just the international
  // 6-15-digit envelope.
  if (meta.localLength === 0) {
    if (d.length < LOOSE_MIN) {
      return { ok: false, error: `${LOOSE_MIN} chiffres minimum / ${LOOSE_MIN} digits min` }
    }
    if (d.length > LOOSE_MAX) {
      return { ok: false, error: `${LOOSE_MAX} chiffres maximum / ${LOOSE_MAX} digits max` }
    }
    return { ok: true }
  }

  // Strict validation for the 5 platform countries.
  if (d.length < meta.localLength) {
    return { ok: false, error: `${meta.localLength} chiffres requis / ${meta.localLength} digits required` }
  }
  if (d.length > meta.localLength) {
    return { ok: false, error: `Max ${meta.localLength} chiffres / Max ${meta.localLength} digits` }
  }
  if (meta.prefixes.length > 0) {
    const ok = meta.prefixes.some(p => d.startsWith(p))
    if (!ok) {
      return { ok: false, error: `Préfixe invalide (${meta.prefixes.join(', ')}) / Invalid prefix` }
    }
  }
  return { ok: true }
}

export function composeFullPhone(local: string, iso: CountryISO): string {
  const d = digitsOnly(local)
  if (!d) return ''
  const meta = COUNTRIES[iso]
  if (!meta) return ''
  return `+${meta.dialCode}${d}`
}

export function formatPhoneDisplay(fullPhone: string | null | undefined): string {
  if (!fullPhone) return ''
  const { country, local } = splitIntoCountryAndLocal(fullPhone)
  if (!country) return String(fullPhone)
  const grouped = formatLocalPhone(local, country.iso)
  return `${country.code} ${grouped}`.trim()
}

// Prepend a country code to a number that may already be international
// or may be a bare local number. Used by the WhatsApp invite parser so
// vendors don't have to type the +237.
export function ensureInternational(raw: string, fallbackCountry: CountryMeta): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('+')) return trimmed.replace(/[^\d+]/g, '')
  if (trimmed.startsWith('00')) return '+' + trimmed.slice(2).replace(/[^\d]/g, '')
  const digits = trimmed.replace(/[^\d]/g, '')
  if (!digits) return ''
  for (const meta of COUNTRY_LIST) {
    if (digits.startsWith(meta.dialCode) && digits.length > meta.localLength) {
      return '+' + digits
    }
  }
  return '+' + fallbackCountry.dialCode + digits
}

// ── Dropdown helpers ────────────────────────────────────────────────────────

// City-match country first (the only "pinned" entry), then every other
// country alphabetically by the current locale's display name. The
// PhoneInput renders a divider between the pinned entry and the rest.
export function sortedCountriesFor(
  currentCity: string | null | undefined,
  locale: Locale,
): CountryMeta[] {
  const cityCountry = getCountryFromCity(currentCity)
  const nameOf = (c: CountryMeta) => (locale === 'fr' ? c.nameFr : c.name)
  const others = COUNTRY_LIST
    .filter(c => c.iso !== cityCountry.iso)
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b), locale))
  return [cityCountry, ...others]
}

// Substring match against EN name, FR name, ISO, dial code. Case- and
// diacritic-insensitive so "etats" matches "États-Unis".
export function matchesCountrySearch(meta: CountryMeta, q: string): boolean {
  const needle = normalizeForSearch(q)
  if (!needle) return true
  return (
    normalizeForSearch(meta.name).includes(needle)
    || normalizeForSearch(meta.nameFr).includes(needle)
    || meta.iso.toLowerCase().includes(needle)
    || meta.code.includes(needle)
    || meta.dialCode.includes(needle)
  )
}

function normalizeForSearch(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}
