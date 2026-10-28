import { formatFCFA } from '@/lib/money'
// Delivery by the restaurant's own rider (V1). Pure and client-safe, so the
// checkout, the dashboard, the API and the WhatsApp messages share one copy
// of the rules and wording.
//
// A restaurant delivers only when it switched delivery on. Take-away is
// always possible. The delivery time shown is the preparation time plus
// delivery_extra_min (the ride).

export type Fulfilment = 'pickup' | 'delivery'

export const DELIVERY_FEE_MAX       = 100_000 // same bound as the DB CHECK
export const DELIVERY_EXTRA_DEFAULT = 15
export const DELIVERY_EXTRA_MAX     = 180

export const DELIVERY_ADDRESS_MAX  = 200
export const DELIVERY_LANDMARK_MAX = 120

export const DELIVERY_FIELDS_REQUIRED_TEXT =
  'Adresse, repère et téléphone requis pour la livraison / Address, landmark and phone required for delivery'
export const DELIVERY_OFF_TEXT =
  'Ce restaurant ne livre pas. Choisissez « À emporter ». / This restaurant does not deliver. Choose "Take-away".'

export function normalizeFulfilment(v: unknown): Fulfilment {
  return v === 'delivery' ? 'delivery' : 'pickup'
}

// "25-35 min" for a delivery: the prep range shifted by the ride time.
// null when the restaurant has no prep range (the badge is then hidden).
export function formatDeliveryTime(
  prepMin?: number | null,
  prepMax?: number | null,
  extraMin?: number | null,
): string | null {
  if (prepMin == null || prepMax == null) return null
  if (!Number.isFinite(prepMin) || !Number.isFinite(prepMax)) return null
  const extra = Number.isFinite(Number(extraMin)) && extraMin != null ? Number(extraMin) : DELIVERY_EXTRA_DEFAULT
  return `${prepMin + extra}-${prepMax + extra} min`
}

export interface DeliverySettings {
  delivery_enabled: boolean
  delivery_fee: number
  delivery_extra_min: number
}

export type DeliverySettingsValidation =
  | { ok: true; settings: DeliverySettings }
  | { ok: false; error: string }

export function validateDeliverySettings(raw: {
  delivery_enabled?: unknown
  delivery_fee?: unknown
  delivery_extra_min?: unknown
}): DeliverySettingsValidation {
  if (typeof raw.delivery_enabled !== 'boolean') {
    return { ok: false, error: 'Livraison : oui ou non / Delivery: yes or no' }
  }
  const fee = Number(raw.delivery_fee ?? 0)
  if (!Number.isInteger(fee) || fee < 0 || fee > DELIVERY_FEE_MAX) {
    return { ok: false, error: `Frais de livraison invalides (0 à ${formatFCFA(DELIVERY_FEE_MAX)}) / Invalid delivery fee (0 to ${formatFCFA(DELIVERY_FEE_MAX)})` }
  }
  const extra = Number(raw.delivery_extra_min ?? DELIVERY_EXTRA_DEFAULT)
  if (!Number.isInteger(extra) || extra < 0 || extra > DELIVERY_EXTRA_MAX) {
    return { ok: false, error: `Temps de trajet invalide (0 à ${DELIVERY_EXTRA_MAX} min) / Invalid ride time (0 to ${DELIVERY_EXTRA_MAX} min)` }
  }
  return { ok: true, settings: { delivery_enabled: raw.delivery_enabled, delivery_fee: fee, delivery_extra_min: extra } }
}

// The Livraison | À emporter choice made on the restaurant page, carried to
// the checkout for the same restaurant (this tab only). Storage may be
// blocked: then the checkout simply starts on take-away.
const FULFILMENT_KEY = (restaurantId: string) => `tn_fulfilment_${restaurantId}`

export function rememberFulfilment(restaurantId: string, f: Fulfilment): void {
  try { sessionStorage.setItem(FULFILMENT_KEY(restaurantId), f) } catch { /* storage unavailable */ }
}

export function rememberedFulfilment(restaurantId: string): Fulfilment | null {
  try {
    const v = sessionStorage.getItem(FULFILMENT_KEY(restaurantId))
    return v === 'delivery' || v === 'pickup' ? v : null
  } catch {
    return null
  }
}
