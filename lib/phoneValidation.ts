// Country metadata + phone-number helpers shared by the PhoneInput UI and
// the server-side normalisers.
//
// Two tiers of countries live here together:
//
//   1. Platform countries (CM/CI/SN/TG/BJ) — strict validation against
//      the operator prefix ranges that the PawaPay MNO routing in
//      lib/pawapay.ts depends on. Misses here surface as "Numéro non
//      supporté" in the UI before submission.
//
//   2. Everyone else — loose 6-15-digit length check, no prefix list.
//      These exist so tourists and diaspora customers can still enter
//      their own +44 / +1 / +33 / etc. number for the account / order
//      contact field. They CAN'T be used for MoMo payments (PawaPay
//      has no correspondent for them) and the order page surfaces a
//      note about that limitation separately.
//
// Country sort order in the dropdown:
//   - city-match (auto-selected) → top, then …
//   - tier order: platform → tourist → african → world
//   - alphabetical within tier (by English name)
//
// `iso` is typed as a free string so callers don't have to keep an
// exhaustive union in sync every time a country is added. The platform
// set is gated separately via PLATFORM_ISO_SET.

export type CountryISO = string
export type CountryTier = 'platform' | 'tourist' | 'african' | 'world'

export interface CountryMeta {
  iso:          CountryISO
  name:         string        // English name, used for search + sort
  nameFr:       string
  flag:         string
  code:         string        // "+33"
  dialCode:     string        // "33"
  tier:         CountryTier
  // Exact local length for strict-validated platform countries.
  // 0 means "flexible" — validateLocalPhone falls back to the 6-15
  // range check.
  localLength:  number
  // Allowed leading prefixes (2-char strings). Empty array means
  // "any prefix accepted".
  prefixes:     string[]
  placeholder:  string
  groupSizes:   number[]      // spacing pattern, e.g. [3,3,3]
}

// Compact helper so the country list stays readable. Non-platform
// countries fall back to generic 3-3-3 grouping and the "Numéro local"
// placeholder pattern.
function loose(
  iso: string, code: string, name: string, nameFr: string, flag: string,
  tier: CountryTier,
  opts: Partial<Pick<CountryMeta, 'placeholder' | 'groupSizes'>> = {},
): CountryMeta {
  return {
    iso, code, dialCode: code.replace(/^\+/, ''),
    name, nameFr, flag, tier,
    localLength: 0, prefixes: [],
    placeholder: opts.placeholder ?? 'XXX XXX XXX',
    groupSizes:  opts.groupSizes  ?? [3, 3, 3],
  }
}

// Platform countries — strict validation. These five are duplicated
// from the previous version of this file with the same prefix lists
// they had before. PawaPay's MNO routing in lib/pawapay.ts depends on
// these matching exactly, so any change here needs a paired change
// there.
const PLATFORM: CountryMeta[] = [
  {
    iso: 'CM', code: '+237', dialCode: '237',
    name: 'Cameroon', nameFr: 'Cameroun', flag: '🇨🇲', tier: 'platform',
    localLength: 9, prefixes: ['65', '67', '68', '69'],
    placeholder: '6XX XXX XXX', groupSizes: [3, 3, 3],
  },
  {
    iso: 'CI', code: '+225', dialCode: '225',
    name: "Côte d'Ivoire", nameFr: "Côte d'Ivoire", flag: '🇨🇮', tier: 'platform',
    localLength: 10, prefixes: ['01', '05', '06', '07', '08', '09'],
    placeholder: 'XX XX XX XX XX', groupSizes: [2, 2, 2, 2, 2],
  },
  {
    iso: 'SN', code: '+221', dialCode: '221',
    name: 'Senegal', nameFr: 'Sénégal', flag: '🇸🇳', tier: 'platform',
    localLength: 9, prefixes: ['76', '77', '78'],
    placeholder: '7X XXX XX XX', groupSizes: [2, 3, 2, 2],
  },
  {
    iso: 'TG', code: '+228', dialCode: '228',
    name: 'Togo', nameFr: 'Togo', flag: '🇹🇬', tier: 'platform',
    localLength: 8, prefixes: ['9'],
    placeholder: '9X XX XX XX', groupSizes: [2, 2, 2, 2],
  },
  {
    iso: 'BJ', code: '+229', dialCode: '229',
    name: 'Benin', nameFr: 'Bénin', flag: '🇧🇯', tier: 'platform',
    localLength: 8, prefixes: ['94', '95', '96', '97'],
    placeholder: 'XX XX XX XX', groupSizes: [2, 2, 2, 2],
  },
]

const TOURIST: CountryMeta[] = [
  loose('FR', '+33',  'France',      'France',      '🇫🇷', 'tourist'),
  loose('GB', '+44',  'UK',          'Royaume-Uni', '🇬🇧', 'tourist'),
  loose('US', '+1',   'USA',         'États-Unis',  '🇺🇸', 'tourist'),
  loose('CA', '+1',   'Canada',      'Canada',      '🇨🇦', 'tourist'),
  loose('DE', '+49',  'Germany',     'Allemagne',   '🇩🇪', 'tourist'),
  loose('BE', '+32',  'Belgium',     'Belgique',    '🇧🇪', 'tourist'),
  loose('CH', '+41',  'Switzerland', 'Suisse',      '🇨🇭', 'tourist'),
  loose('IT', '+39',  'Italy',       'Italie',      '🇮🇹', 'tourist'),
  loose('ES', '+34',  'Spain',       'Espagne',     '🇪🇸', 'tourist'),
  loose('NL', '+31',  'Netherlands', 'Pays-Bas',    '🇳🇱', 'tourist'),
  loose('PT', '+351', 'Portugal',    'Portugal',    '🇵🇹', 'tourist'),
]

const AFRICAN: CountryMeta[] = [
  loose('NG', '+234', 'Nigeria',                  'Nigéria',                   '🇳🇬', 'african'),
  loose('GH', '+233', 'Ghana',                    'Ghana',                     '🇬🇭', 'african'),
  loose('GA', '+241', 'Gabon',                    'Gabon',                     '🇬🇦', 'african'),
  loose('CD', '+243', 'DRC',                      'RD Congo',                  '🇨🇩', 'african'),
  loose('CG', '+242', 'Congo',                    'Congo',                     '🇨🇬', 'african'),
  loose('TD', '+235', 'Chad',                     'Tchad',                     '🇹🇩', 'african'),
  loose('CF', '+236', 'Central African Republic', 'République centrafricaine', '🇨🇫', 'african'),
  loose('GQ', '+240', 'Equatorial Guinea',        'Guinée équatoriale',        '🇬🇶', 'african'),
  loose('ML', '+223', 'Mali',                     'Mali',                      '🇲🇱', 'african'),
  loose('BF', '+226', 'Burkina Faso',             'Burkina Faso',              '🇧🇫', 'african'),
  loose('GN', '+224', 'Guinea',                   'Guinée',                    '🇬🇳', 'african'),
  loose('MA', '+212', 'Morocco',                  'Maroc',                     '🇲🇦', 'african'),
  loose('TN', '+216', 'Tunisia',                  'Tunisie',                   '🇹🇳', 'african'),
  loose('DZ', '+213', 'Algeria',                  'Algérie',                   '🇩🇿', 'african'),
  loose('EG', '+20',  'Egypt',                    'Égypte',                    '🇪🇬', 'african'),
  loose('KE', '+254', 'Kenya',                    'Kenya',                     '🇰🇪', 'african'),
  loose('TZ', '+255', 'Tanzania',                 'Tanzanie',                  '🇹🇿', 'african'),
  loose('ZA', '+27',  'South Africa',             'Afrique du Sud',            '🇿🇦', 'african'),
  loose('RW', '+250', 'Rwanda',                   'Rwanda',                    '🇷🇼', 'african'),
  loose('UG', '+256', 'Uganda',                   'Ouganda',                   '🇺🇬', 'african'),
  loose('ET', '+251', 'Ethiopia',                 'Éthiopie',                  '🇪🇹', 'african'),
  loose('MG', '+261', 'Madagascar',               'Madagascar',                '🇲🇬', 'african'),
]

const WORLD: CountryMeta[] = [
  loose('BR', '+55',  'Brazil',       'Brésil',       '🇧🇷', 'world'),
  loose('CN', '+86',  'China',        'Chine',        '🇨🇳', 'world'),
  loose('IN', '+91',  'India',        'Inde',         '🇮🇳', 'world'),
  loose('JP', '+81',  'Japan',        'Japon',        '🇯🇵', 'world'),
  loose('KR', '+82',  'South Korea',  'Corée du Sud', '🇰🇷', 'world'),
  loose('AU', '+61',  'Australia',    'Australie',    '🇦🇺', 'world'),
  loose('MX', '+52',  'Mexico',       'Mexique',      '🇲🇽', 'world'),
  loose('AE', '+971', 'UAE',          'Émirats arabes unis', '🇦🇪', 'world'),
  loose('SA', '+966', 'Saudi Arabia', 'Arabie saoudite', '🇸🇦', 'world'),
  loose('TR', '+90',  'Turkey',       'Turquie',      '🇹🇷', 'world'),
  loose('RU', '+7',   'Russia',       'Russie',       '🇷🇺', 'world'),
  loose('PL', '+48',  'Poland',       'Pologne',      '🇵🇱', 'world'),
  loose('SE', '+46',  'Sweden',       'Suède',        '🇸🇪', 'world'),
  loose('NO', '+47',  'Norway',       'Norvège',      '🇳🇴', 'world'),
  loose('DK', '+45',  'Denmark',      'Danemark',     '🇩🇰', 'world'),
  loose('AT', '+43',  'Austria',      'Autriche',     '🇦🇹', 'world'),
]

// Master list — order here is the default sort order: platform first
// (in business-priority order), then alphabetical within tier.
export const COUNTRY_LIST: CountryMeta[] = [
  ...PLATFORM,
  ...sortByName(TOURIST),
  ...sortByName(AFRICAN),
  ...sortByName(WORLD),
]

function sortByName(arr: CountryMeta[]): CountryMeta[] {
  return [...arr].sort((a, b) => a.name.localeCompare(b.name))
}

// Indexed by iso for O(1) lookups in detectCountry / getCountryFromCity.
export const COUNTRIES: Record<string, CountryMeta> = Object.fromEntries(
  COUNTRY_LIST.map(c => [c.iso, c]),
)

const PLATFORM_ISO_SET = new Set(PLATFORM.map(c => c.iso))
export function isPlatformCountry(iso: string): boolean {
  return PLATFORM_ISO_SET.has(iso)
}

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
// Longer dial codes are checked first so '+1' (US/Canada) doesn't
// shadow '+1XXX' if more countries are added later.
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

function digitsOnly(s: string): string {
  return (s ?? '').replace(/\D/g, '')
}

// Insert spaces according to the country's grouping pattern. Extra digits
// past the configured grouping are kept (so users see their typo) and
// caught by validateLocalPhone.
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

// International min/max for non-platform countries (E.164 says max 15
// digits including country code; subscriber numbers in practice are
// 6-13 long).
const LOOSE_MIN = 6
const LOOSE_MAX = 15

export function validateLocalPhone(local: string, iso: CountryISO): LocalPhoneValidation {
  const meta = COUNTRIES[iso]
  if (!meta) return { ok: false, error: 'Pays inconnu / Unknown country' }
  const d = digitsOnly(local)
  if (d.length === 0) return { ok: false, error: 'Numéro requis / Phone required' }

  // Loose validation for non-platform countries: just check the digit
  // count falls inside the international 6-15 window.
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

// Compose the full +E.164 form from the country + local input. Returns
// '' for an empty local so callers can short-circuit ("don't submit").
export function composeFullPhone(local: string, iso: CountryISO): string {
  const d = digitsOnly(local)
  if (!d) return ''
  const meta = COUNTRIES[iso]
  if (!meta) return ''
  return `+${meta.dialCode}${d}`
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

// Dropdown sort: city-match first (highlighted), then tier order,
// then alphabetical English name inside each tier. Returns a new
// array — never mutates COUNTRY_LIST.
export function sortedCountriesFor(currentCity: string | null | undefined): CountryMeta[] {
  const cityCountry = getCountryFromCity(currentCity)
  const tierOrder: Record<CountryTier, number> = {
    platform: 0, tourist: 1, african: 2, world: 3,
  }
  return [...COUNTRY_LIST].sort((a, b) => {
    if (a.iso === cityCountry.iso && b.iso !== cityCountry.iso) return -1
    if (b.iso === cityCountry.iso && a.iso !== cityCountry.iso) return 1
    const t = tierOrder[a.tier] - tierOrder[b.tier]
    if (t !== 0) return t
    return a.name.localeCompare(b.name)
  })
}

// Substring match against name, French name, ISO, dial code.
export function matchesCountrySearch(meta: CountryMeta, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return (
    meta.name.toLowerCase().includes(needle)
    || meta.nameFr.toLowerCase().includes(needle)
    || meta.iso.toLowerCase().includes(needle)
    || meta.code.includes(needle)
    || meta.dialCode.includes(needle)
  )
}
