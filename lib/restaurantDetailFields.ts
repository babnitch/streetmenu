// The owner-editable restaurant details (lib/restaurantDetails.ts): field
// names and labels. Client-safe.

export const DETAIL_FIELDS = ['name', 'description', 'cuisine_type', 'city', 'neighborhood', 'address', 'lat', 'lng', 'phone', 'whatsapp'] as const
export type DetailField = typeof DETAIL_FIELDS[number]

/** Changes the admins see in « Modifié par le propriétaire ». */
export const NOTICE_FIELDS: readonly DetailField[] = ['name', 'address', 'city', 'neighborhood', 'lat', 'lng', 'phone', 'whatsapp']

export const DETAIL_LABELS: Record<DetailField, { fr: string; en: string }> = {
  name: { fr: 'Nom', en: 'Name' }, description: { fr: 'Description', en: 'Description' },
  cuisine_type: { fr: 'Cuisine', en: 'Cuisine' }, city: { fr: 'Ville', en: 'City' },
  neighborhood: { fr: 'Quartier', en: 'Area' }, address: { fr: 'Adresse', en: 'Address' },
  lat: { fr: 'Position (lat.)', en: 'Pin (lat.)' }, lng: { fr: 'Position (long.)', en: 'Pin (long.)' },
  phone: { fr: 'Téléphone', en: 'Phone' }, whatsapp: { fr: 'WhatsApp', en: 'WhatsApp' },
}


/** "4.0525, 9.7001" (or with a space / semicolon) → a pin, else null. */
export function parsePin(text: string): { lat: number; lng: number } | null {
  const m = text.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)$/)
  if (!m) return null
  const lat = Number(m[1]), lng = Number(m[2])
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null
}
