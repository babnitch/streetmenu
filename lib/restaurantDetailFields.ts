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

