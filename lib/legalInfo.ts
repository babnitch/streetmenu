// Legal & contact info (U1) — client-safe shape and helpers. Values live in
// platform_settings ('legal_contact'), edited in Admin → Plateforme. Any
// empty value hides its part of the footer / pages (never an empty icon).

export const LEGAL_FIELDS = [
  'company_name', 'company_number', 'company_address', 'contact_email', 'contact_phone',
  'support_whatsapp', 'instagram', 'tiktok', 'facebook', 'whatsapp_channel',
] as const
export type LegalField = typeof LEGAL_FIELDS[number]
export type LegalInfo = Partial<Record<LegalField, string>>

export const LEGAL_LABELS: Record<LegalField, { fr: string; en: string; hint?: string }> = {
  company_name:     { fr: 'Nom de la société', en: 'Company name' },
  company_number:   { fr: 'N° d\'immatriculation (RCCM / IDE…)', en: 'Registration number' },
  company_address:  { fr: 'Adresse', en: 'Address' },
  contact_email:    { fr: 'E-mail de contact', en: 'Contact e-mail' },
  contact_phone:    { fr: 'Téléphone de contact', en: 'Contact phone', hint: '+237…' },
  support_whatsapp: { fr: 'WhatsApp du support', en: 'Support WhatsApp', hint: '+237…' },
  instagram:        { fr: 'Instagram (lien)', en: 'Instagram (link)', hint: 'https://instagram.com/…' },
  tiktok:           { fr: 'TikTok (lien)', en: 'TikTok (link)', hint: 'https://tiktok.com/@…' },
  facebook:         { fr: 'Facebook (lien)', en: 'Facebook (link)', hint: 'https://facebook.com/…' },
  whatsapp_channel: { fr: 'Chaîne WhatsApp (lien)', en: 'WhatsApp Channel (link)', hint: 'https://whatsapp.com/channel/…' },
}

const URL_FIELDS: LegalField[] = ['instagram', 'tiktok', 'facebook', 'whatsapp_channel']
const PHONE_FIELDS: LegalField[] = ['contact_phone', 'support_whatsapp']

export type LegalValidation = { ok: true; info: LegalInfo } | { ok: false; error: string; field: LegalField }

export function validateLegalInfo(raw: unknown): LegalValidation {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const info: LegalInfo = {}
  for (const f of LEGAL_FIELDS) {
    const v = typeof src[f] === 'string' ? (src[f] as string).trim().slice(0, 300) : ''
    if (!v) continue
    if (URL_FIELDS.includes(f) && !/^https:\/\/[^\s]+$/.test(v)) return { ok: false, field: f, error: 'Lien https:// requis / https:// link required' }
    if (PHONE_FIELDS.includes(f) && !/^\+[0-9]{8,15}$/.test(v.replace(/[\s.-]/g, ''))) return { ok: false, field: f, error: 'Numéro au format +237… / Number as +237…' }
    if (f === 'contact_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, field: f, error: 'E-mail invalide / Invalid e-mail' }
    info[f] = PHONE_FIELDS.includes(f) ? v.replace(/[\s.-]/g, '') : v
  }
  return { ok: true, info }
}

// "Tchop & Ndjoka est un nom commercial de X, n° Y, Z · e-mail · phone" —
// only the parts that are set; '' when there is no company name.
export function legalLine(i: LegalInfo, locale: 'fr' | 'en'): string {
  if (!i.company_name) return ''
  const who = [i.company_name, i.company_number ? `${locale === 'fr' ? 'n°' : 'no.'} ${i.company_number}` : '', i.company_address ?? '']
    .filter(Boolean).join(', ')
  const head = locale === 'fr' ? `Tchop & Ndjoka est un nom commercial de ${who}` : `Tchop & Ndjoka is a trading name of ${who}`
  return [head, i.contact_email, i.contact_phone].filter(Boolean).join(' · ')
}

export const waLink = (phone: string, text?: string) =>
  `https://wa.me/${phone.replace(/\D/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`
