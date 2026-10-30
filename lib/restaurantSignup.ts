import { CITIES, CITY_CENTRES, type City } from './cities'
// Adding a restaurant — the lists shared by the WhatsApp signup (app/api/
// whatsapp/incoming) and the web form (/pro/restaurants/new), so both store
// the same values.

// The platform cities (lib/cities.ts) and their centre — a new restaurant's map pin
// until its owner places it (the web form can send the phone's position).
export const RESTAURANT_CITIES = CITIES.map(name => ({ name, lat: CITY_CENTRES[name].lat, lng: CITY_CENTRES[name].lng }))

export type RestaurantCity = City

export function cityCentre(city: string | null | undefined): { lat: number; lng: number } | null {
  const c = RESTAURANT_CITIES.find(x => x.name === city)
  return c ? { lat: c.lat, lng: c.lng } : null
}

// Food types, in the bot's numbered order (1–6). Stored as cuisine_type.
export const FOOD_TYPES = [
  { value: 'Camerounaise', fr: 'Camerounaise', en: 'Cameroonian' },
  { value: 'Sénégalaise',  fr: 'Sénégalaise',  en: 'Senegalese' },
  { value: 'Ivoirienne',   fr: 'Ivoirienne',   en: 'Ivorian' },
  { value: 'Fast-food',    fr: 'Fast-food',    en: 'Fast food' },
  { value: 'Grillades',    fr: 'Grillades',    en: 'Grills' },
  { value: 'Autre',        fr: 'Autre',        en: 'Other' },
] as const

export function isFoodType(v: unknown): v is typeof FOOD_TYPES[number]['value'] {
  return FOOD_TYPES.some(f => f.value === v)
}

// A position sent by the browser ("Utiliser ma position actuelle") is kept
// only when it is within ~60 km of the chosen city's centre, so a typo or a
// phone abroad can't drop the pin on another continent.
export function acceptPosition(city: string, lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const centre = cityCentre(city)
  const la = Number(lat), ln = Number(lng)
  if (!centre || !Number.isFinite(la) || !Number.isFinite(ln)) return null
  return Math.abs(la - centre.lat) < 0.55 && Math.abs(ln - centre.lng) < 0.55 ? { lat: la, lng: ln } : null
}

// "Registered, pending approval" — the bot's message, in the owner's language.
export function registeredText(name: string, pageUrl: string, lang: 'fr' | 'en'): string {
  return lang === 'en'
    ? `✅ *${name}* is registered! 🎉\nPending approval (24h).\n\nYour page:\n${pageUrl}\n\n` +
      `Send *help* for available commands.\n\n_You can update the photo later by sending "photo restaurant"._`
    : `✅ *${name}* est enregistré ! 🎉\nEn attente d'approbation (24h).\n\nVotre page :\n${pageUrl}\n\n` +
      `Envoyez *aide* pour les commandes disponibles.\n\n_Vous pourrez changer la photo plus tard en envoyant "photo restaurant"._`
}
