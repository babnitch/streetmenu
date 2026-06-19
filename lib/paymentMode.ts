// ── Payment mode ──────────────────────────────────────────────────────────────
// Restaurants and events both carry a `payment_mode` (how customers pay on the
// website) plus a separate `whatsapp_payment_enabled` flag (whether online
// payment is also offered inside the WhatsApp flow). This module is the single
// source of truth for resolving those two settings into an *effective* mode for
// a given surface, so checkout, the event page, WhatsApp ordering, the vendor
// dashboard and the admin tools never drift apart.
//
// Modes:
//   payment_only      — customer MUST pay online (Mobile Money). No reservation.
//   reservation_only  — customer reserves, pays on-site / at the door. DEFAULT.
//   both              — customer chooses at checkout: pay now OR reserve.

export type PaymentMode = 'payment_only' | 'reservation_only' | 'both'

export const PAYMENT_MODES: PaymentMode[] = ['payment_only', 'reservation_only', 'both']

export const DEFAULT_PAYMENT_MODE: PaymentMode = 'reservation_only'

// Coerce arbitrary input (DB row, request body, legacy null) into a valid mode.
// Anything unrecognised falls back to the safe default (reservation_only).
export function normalizeMode(value: unknown): PaymentMode {
  return value === 'payment_only' || value === 'both' ? value : 'reservation_only'
}

// Back-compat bridge: derive a mode from the legacy boolean payment_enabled
// column for any row that predates the migration and somehow lacks a mode.
export function modeFromLegacy(paymentEnabled: boolean | null | undefined): PaymentMode {
  return paymentEnabled ? 'both' : 'reservation_only'
}

// Keep the legacy payment_enabled column in sync with a mode so any reader we
// haven't migrated yet still behaves correctly (true = online payment offered).
export function legacyEnabledFromMode(mode: PaymentMode): boolean {
  return mode !== 'reservation_only'
}

export function canPayOnline(mode: PaymentMode): boolean {
  return mode === 'payment_only' || mode === 'both'
}

export function canReserve(mode: PaymentMode): boolean {
  return mode === 'reservation_only' || mode === 'both'
}

// Effective mode on the website. Free events can never take online payment, so
// they always collapse to reservation_only regardless of the stored setting.
export function effectiveWebMode(mode: PaymentMode, isFree = false): PaymentMode {
  if (isFree) return 'reservation_only'
  return mode
}

// Effective mode inside WhatsApp. The whatsapp_payment_enabled flag gates online
// payment independently of the web mode: when it's off, WhatsApp is always
// reservation_only. When it's on, WhatsApp follows the same payment_mode rules
// (still collapsing to reservation_only for free events).
export function effectiveWhatsAppMode(
  mode: PaymentMode,
  whatsappPaymentEnabled: boolean,
  isFree = false,
): PaymentMode {
  if (isFree) return 'reservation_only'
  if (!whatsappPaymentEnabled) return 'reservation_only'
  return mode
}
