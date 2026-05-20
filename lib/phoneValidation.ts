// Country metadata + phone-number helpers shared by the PhoneInput UI and
// the server-side normalisers. The PawaPay MNO routing in lib/pawapay.ts
// is the source of truth for *operator* prefix mapping; this file mirrors
// the prefix sets so the input can validate before submission.
//
// Five supported countries (matches PawaPay coverage):
//   CM Cameroon  +237  ·  CI Côte d'Ivoire +225
//   SN Senegal   +221  ·  TG Togo          +228
//   BJ Benin     +229
//
// Togo (+228) has no PawaPay correspondent — phone display works, but a
// MoMo deposit from a +228 wallet will fail upstream. That's intentional
// and matches the spec ("Lomé → 🇹🇬 +228").

export type CountryISO = 'CM' | 'CI' | 'SN' | 'TG' | 'BJ'

export interface CountryMeta {
  iso:          CountryISO
  name:         string        // "Cameroon"
  nameFr:       string        // "Cameroun"
  flag:         string        // "🇨🇲"
  code:         string        // "+237"
  dialCode:     string        // "237" (no '+')
  localLength:  number        // 9 for CM, 10 for CI, etc.
  // Allowed first-N-digit prefixes for the local number, e.g. ['67','68']
  // for Cameroon MTN. An empty array means "any prefix allowed" — useful
  // for Togo where we don't have a curated MNO list.
  prefixes:     string[]
  placeholder:  string        // "6XX XXX XXX"
  // Spacing pattern applied to local digits — e.g. [3,3,3] groups 9 digits
  // as "XXX XXX XXX".
  groupSizes:   number[]
}

export const COUNTRIES: Record<CountryISO, CountryMeta> = {
  CM: {
    iso: 'CM', name: 'Cameroon', nameFr: 'Cameroun', flag: '🇨🇲',
    code: '+237', dialCode: '237',
    localLength: 9,
    prefixes: ['65', '67', '68', '69'],
    placeholder: '6XX XXX XXX',
    groupSizes: [3, 3, 3],
  },
  CI: {
    iso: 'CI', name: "Côte d'Ivoire", nameFr: "Côte d'Ivoire", flag: '🇨🇮',
    code: '+225', dialCode: '225',
    localLength: 10,
    prefixes: ['01', '05', '06', '07', '08', '09'],
    placeholder: 'XX XX XX XX XX',
    groupSizes: [2, 2, 2, 2, 2],
  },
  SN: {
    iso: 'SN', name: 'Senegal', nameFr: 'Sénégal', flag: '🇸🇳',
    code: '+221', dialCode: '221',
    localLength: 9,
    prefixes: ['76', '77', '78'],
    placeholder: '7X XXX XX XX',
    groupSizes: [2, 3, 2, 2],
  },
  TG: {
    iso: 'TG', name: 'Togo', nameFr: 'Togo', flag: '🇹🇬',
    code: '+228', dialCode: '228',
    localLength: 8,
    prefixes: ['9'],
    placeholder: '9X XX XX XX',
    groupSizes: [2, 2, 2, 2],
  },
  BJ: {
    iso: 'BJ', name: 'Benin', nameFr: 'Bénin', flag: '🇧🇯',
    code: '+229', dialCode: '229',
    localLength: 8,
    prefixes: ['94', '95', '96', '97'],
    placeholder: 'XX XX XX XX',
    groupSizes: [2, 2, 2, 2],
  },
}

export const COUNTRY_LIST: CountryMeta[] = Object.values(COUNTRIES)

// City → default country. Cities not listed fall back to CM (the platform's
// largest market). This is a one-way default — the user can override with
// the country dropdown.
const CITY_TO_COUNTRY: Record<string, CountryISO> = {
  // Cameroon
  'yaoundé': 'CM', 'yaounde': 'CM', 'douala': 'CM', 'bafoussam': 'CM',
  // Côte d'Ivoire
  'abidjan': 'CI', 'bouaké': 'CI', 'bouake': 'CI', 'yamoussoukro': 'CI',
  // Senegal
  'dakar': 'SN', 'thiès': 'SN', 'thies': 'SN', 'saint-louis': 'SN',
  // Togo
  'lomé': 'TG', 'lome': 'TG',
  // Benin
  'cotonou': 'BJ', 'porto-novo': 'BJ',
}

export function getCountryFromCity(city: string | null | undefined): CountryMeta {
  const key = (city ?? '').toLowerCase().trim()
  const iso = CITY_TO_COUNTRY[key] ?? 'CM'
  return COUNTRIES[iso]
}

// Detect the country from an international phone (with or without '+').
// Returns null when the dial code doesn't match a supported country.
export function detectCountry(fullPhone: string | null | undefined): CountryMeta | null {
  if (!fullPhone) return null
  const digits = String(fullPhone).replace(/[^\d]/g, '')
  if (!digits) return null
  for (const meta of COUNTRY_LIST) {
    if (digits.startsWith(meta.dialCode)) return meta
  }
  return null
}

// Pull just the local digits out of an international phone, given the
// country it belongs to. Falls back to digits-minus-dial-code; returns
// the input unchanged if the country can't be guessed.
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

// Strip everything but digits.
function digitsOnly(s: string): string {
  return (s ?? '').replace(/\D/g, '')
}

// Insert spaces according to the country's grouping pattern. Extra digits
// past the expected length are kept (so users see their typo) and are
// caught by validateLocalPhone.
export function formatLocalPhone(local: string, iso: CountryISO): string {
  const meta = COUNTRIES[iso]
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

export function validateLocalPhone(local: string, iso: CountryISO): LocalPhoneValidation {
  const meta = COUNTRIES[iso]
  const d = digitsOnly(local)
  if (d.length === 0) return { ok: false, error: 'Numéro requis / Phone required' }
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

// Compose the full +E.164 form from the country + local input. Returns
// '' for an empty local so callers can short-circuit ("don't submit").
export function composeFullPhone(local: string, iso: CountryISO): string {
  const d = digitsOnly(local)
  if (!d) return ''
  return `+${COUNTRIES[iso].dialCode}${d}`
}

// Pretty-print a stored intl number for display. Falls back to the input
// when the country can't be guessed.
export function formatPhoneDisplay(fullPhone: string | null | undefined): string {
  if (!fullPhone) return ''
  const { country, local } = splitIntoCountryAndLocal(fullPhone)
  if (!country) return String(fullPhone)
  const grouped = formatLocalPhone(local, country.iso)
  return `${country.code} ${grouped}`.trim()
}

// Prepend a country code to a number that may already be international
// or may be a bare local number. Used by the WhatsApp "inviter 670000000
// manager" parser so vendors don't have to type the +237.
//
// - "+237670000000"  → unchanged
// - "00237670000000" → "+237670000000"
// - "670000000"      → "+" + dialCode + "670000000"
export function ensureInternational(raw: string, fallbackCountry: CountryMeta): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('+')) return trimmed.replace(/[^\d+]/g, '')
  if (trimmed.startsWith('00')) return '+' + trimmed.slice(2).replace(/[^\d]/g, '')
  const digits = trimmed.replace(/[^\d]/g, '')
  if (!digits) return ''
  // If the bare number already starts with a known dial code, assume it's
  // international and just add the '+'. Guards against vendors typing
  // "237670000000" without the plus sign.
  for (const meta of COUNTRY_LIST) {
    if (digits.startsWith(meta.dialCode) && digits.length > meta.localLength) {
      return '+' + digits
    }
  }
  return '+' + fallbackCountry.dialCode + digits
}
