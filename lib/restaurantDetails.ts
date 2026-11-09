// The restaurant's own details, edited by its OWNER (dashboard → Réglages →
// « Infos du restaurant »): name, description, cuisine, city, neighbourhood,
// address, map pin, phone, WhatsApp. The change goes live at once — no new
// approval — and a change to how customers find or reach the restaurant
// (NOTICE_FIELDS) is listed for the admins (restaurant_change_notices).
// Pure checks; the route (app/api/restaurants/[id]/details) writes + audits.
//
// Never here (admin-only or protected): status / approval, is_active,
// managed_by_platform, modules, payment, payout number, photo credit.

import { sanitizeText } from '@/lib/sanitize'
import { normalizePhone } from '@/lib/phone'
import { chooseCity, chooseCuisine } from '@/lib/refChoice'
import { cityCentre } from '@/lib/cities'
import { acceptPosition } from '@/lib/restaurantSignup'

import { type DetailField } from '@/lib/restaurantDetailFields'
export { DETAIL_FIELDS, NOTICE_FIELDS, DETAIL_LABELS, type DetailField } from '@/lib/restaurantDetailFields'

export type DetailRow = Record<DetailField, string | number | null>
export type DetailsCheck =
  | { ok: true; patch: Partial<DetailRow>; cuisineProposed: string | null }
  | { ok: false; error: string; field: DetailField }

const PHONE = /^\+\d{8,15}$/

/** body keys present = a change. `current` = the row now. Needs the reference
 *  data loaded (getRefData) for the city / cuisine lists. */
export function checkRestaurantDetails(body: Record<string, unknown>, current: DetailRow): DetailsCheck {
  const patch: Partial<DetailRow> = {}
  let cuisineProposed: string | null = null
  const fail = (field: DetailField, fr: string, en: string): DetailsCheck => ({ ok: false, error: `${fr} / ${en}`, field })

  if ('name' in body) {
    const v = sanitizeText(body.name, 120)
    if (v.length < 2) return fail('name', 'Nom trop court', 'Name too short')
    patch.name = v
  }
  if ('description' in body) patch.description = sanitizeText(body.description, 1000) || null
  if ('address' in body) patch.address = sanitizeText(body.address, 200) || null
  if ('neighborhood' in body) {
    const v = sanitizeText(body.neighborhood, 80)
    if (v.length < 2) return fail('neighborhood', 'Quartier requis', 'Area required')
    patch.neighborhood = v
  }
  if ('cuisine_type' in body || 'cuisine_other' in body) {
    const pick = chooseCuisine(body.cuisine_type, body.cuisine_other)
    if (!pick.ok) return fail('cuisine_type', 'Type de cuisine invalide', 'Invalid cuisine')
    patch.cuisine_type = pick.cuisine
    cuisineProposed = pick.proposed
  }
  if ('city' in body) {
    // An owner moves only to a city we serve (no new-city proposal here).
    const pick = chooseCity(body.city, undefined)
    if (!pick.ok || pick.proposed) return fail('city', 'Ville invalide', 'Invalid city')
    patch.city = pick.city
  }
  const city = String(patch.city ?? current.city ?? '')
  if ('lat' in body || 'lng' in body) {
    const pos = acceptPosition(city, body.lat, body.lng)
    if (!pos) return fail('lat', 'Position hors de la ville', 'Pin outside the city')
    patch.lat = pos.lat; patch.lng = pos.lng
  } else if (patch.city && patch.city !== current.city && !acceptPosition(city, current.lat, current.lng)) {
    // New city, old pin elsewhere: the pin moves to the city centre.
    const c = cityCentre(city)
    if (c) { patch.lat = c.lat; patch.lng = c.lng }
  }
  if ('phone' in body) {
    const raw = typeof body.phone === 'string' ? body.phone.trim() : ''
    const p = raw ? normalizePhone(raw) : ''
    if (raw && !PHONE.test(p)) return fail('phone', 'Numéro invalide', 'Invalid number')
    patch.phone = p || null
  }
  if ('whatsapp' in body) {
    const p = normalizePhone(typeof body.whatsapp === 'string' ? body.whatsapp.trim() : '')
    if (!PHONE.test(p)) return fail('whatsapp', 'Numéro WhatsApp invalide', 'Invalid WhatsApp number')
    patch.whatsapp = p
  }
  // Only what really changes.
  for (const k of Object.keys(patch) as DetailField[]) {
    if ((patch[k] ?? null) === (current[k] ?? null)) delete patch[k]
  }
  return { ok: true, patch, cuisineProposed }
}
