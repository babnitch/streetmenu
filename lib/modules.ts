// Modules per pro (M1). Pure and client-safe: the admin sheet, the Pro
// space and the server checks share one list, one set of dependencies and
// one wording.
//
// Basic is not a module: every restaurant has its Vitrine (page, photo,
// menu with prices, hours, info page, "Commander par WhatsApp / Appeler"),
// every organiser has the event page. Modules add to it.
//
// Stored as text[]: restaurants.modules and customers.organizer_modules
// (supabase-modules.sql, with CHECKs for the names and the dependencies).

import { normalizeMode, modeFromLegacy, type PaymentMode } from '@/lib/paymentMode'

export const RESTAURANT_MODULES = [
  'orders', 'payment', 'delivery', 'team', 'promo_codes', 'daily_offer', 'broadcast', 'featured', 'stats',
] as const
export const ORGANIZER_MODULES = [
  'reservations', 'paid_tickets', 'ticket_control', 'promo_codes', 'featured', 'broadcast', 'auto_approve',
] as const

export type RestaurantModule = typeof RESTAURANT_MODULES[number]
export type OrganizerModule = typeof ORGANIZER_MODULES[number]
export type ModuleSubject = 'restaurant' | 'organizer'

export interface ModuleInfo {
  fr: string
  en: string
  descFr: string
  descEn: string
  needs?: string            // the module it depends on
  soon?: boolean            // defined, nothing behind it yet
}

export const RESTAURANT_MODULE_INFO: Record<RestaurantModule, ModuleInfo> = {
  orders:      { fr: 'Commandes', en: 'Orders', descFr: 'Panier et commandes (tableau de bord + WhatsApp), paiement au retrait.', descEn: 'Cart and orders (dashboard + WhatsApp), pay at pickup.' },
  payment:     { fr: 'Paiement Mobile Money', en: 'Mobile Money payment', descFr: 'Paiement en ligne des commandes.', descEn: 'Online payment for orders.', needs: 'orders' },
  delivery:    { fr: 'Livraison', en: 'Delivery', descFr: 'Livraison par votre livreur, avec frais.', descEn: 'Delivery by your own rider, with a fee.', needs: 'orders' },
  team:        { fr: 'Équipe', en: 'Team', descFr: 'Gérants et employés avec leur propre accès.', descEn: 'Managers and staff with their own access.' },
  promo_codes: { fr: 'Codes promo', en: 'Promo codes', descFr: 'Vos propres codes de réduction.', descEn: 'Your own discount codes.' },
  daily_offer: { fr: 'Offre du jour', en: "Today's offer", descFr: 'Un plat à prix réduit ou la livraison offerte.', descEn: 'A dish at a lower price or free delivery.' },
  broadcast:   { fr: 'Diffusion', en: 'Broadcast', descFr: 'Messages WhatsApp aux abonnés de votre ville.', descEn: 'WhatsApp messages to subscribers in your city.' },
  featured:    { fr: 'Mise en avant', en: 'Featured', descFr: 'Une place en vue sur la page d\'accueil.', descEn: 'A featured spot on the home page.' },
  stats:       { fr: 'Statistiques avancées', en: 'Advanced statistics', descFr: 'Ventes, plats et clients en détail.', descEn: 'Sales, dishes and customers in detail.', soon: true },
}

export const ORGANIZER_MODULE_INFO: Record<OrganizerModule, ModuleInfo> = {
  reservations:   { fr: 'Réservations', en: 'Bookings', descFr: 'Réservations gratuites ou paiement sur place.', descEn: 'Free bookings or pay at the door.' },
  paid_tickets:   { fr: 'Billets payants', en: 'Paid tickets', descFr: 'Paiement des billets par Mobile Money.', descEn: 'Tickets paid by Mobile Money.', needs: 'reservations' },
  ticket_control: { fr: 'Contrôle des billets', en: 'Ticket control', descFr: 'Validation des billets à l\'entrée.', descEn: 'Ticket checks at the door.' },
  promo_codes:    { fr: 'Codes promo', en: 'Promo codes', descFr: 'Vos propres codes de réduction.', descEn: 'Your own discount codes.' },
  featured:       { fr: 'À la une', en: 'Featured', descFr: 'Votre événement en vue sur la page d\'accueil.', descEn: 'Your event featured on the home page.' },
  broadcast:      { fr: 'Diffusion', en: 'Broadcast', descFr: 'Messages WhatsApp aux abonnés de votre ville.', descEn: 'WhatsApp messages to subscribers in your city.' },
  auto_approve:   { fr: 'Auto-approbation', en: 'Auto-approval', descFr: 'Vos événements sont publiés sans attendre la validation.', descEn: 'Your events go live without waiting for review.' },
}

export function modulesFor(subject: ModuleSubject): readonly string[] {
  return subject === 'restaurant' ? RESTAURANT_MODULES : ORGANIZER_MODULES
}
export function moduleInfo(subject: ModuleSubject, m: string): ModuleInfo | undefined {
  return subject === 'restaurant'
    ? RESTAURANT_MODULE_INFO[m as RestaurantModule]
    : ORGANIZER_MODULE_INFO[m as OrganizerModule]
}

// What a new pro gets pre-ticked on the approval screen.
export const DEFAULT_ON_APPROVAL: Record<ModuleSubject, string[]> = {
  restaurant: ['orders'],
  organizer:  ['reservations'],
}

// Ticking a module ticks what it needs; unticking a module unticks what
// needs it. Used by the admin sheet so the list it sends is always valid.
export function toggleModule(subject: ModuleSubject, current: readonly string[], m: string, on: boolean): string[] {
  const set = new Set(current)
  if (on) {
    set.add(m)
    const needs = moduleInfo(subject, m)?.needs
    if (needs) set.add(needs)
  } else {
    set.delete(m)
    for (const other of modulesFor(subject)) if (moduleInfo(subject, other)?.needs === m) set.delete(other)
  }
  return modulesFor(subject).filter(x => set.has(x))   // canonical order
}

// The modules a toggle-off would also remove ("Commandes" → Paiement, Livraison).
export function dependents(subject: ModuleSubject, current: readonly string[], m: string): string[] {
  return modulesFor(subject).filter(x => moduleInfo(subject, x)?.needs === m && current.includes(x))
}

export type ModulesValidation = { ok: true; modules: string[] } | { ok: false; error: string }

// A list from a request: known names only, dependencies met, canonical order.
export function validateModules(subject: ModuleSubject, raw: unknown): ModulesValidation {
  if (!Array.isArray(raw) || raw.some(x => typeof x !== 'string')) {
    return { ok: false, error: 'Liste de modules invalide / Invalid module list' }
  }
  const known = modulesFor(subject)
  const unknown = (raw as string[]).find(x => !known.includes(x))
  if (unknown) return { ok: false, error: `Module inconnu : ${unknown} / Unknown module: ${unknown}` }
  const set = new Set(raw as string[])
  for (const m of Array.from(set)) {
    const needs = moduleInfo(subject, m)?.needs
    if (needs && !set.has(needs)) {
      const a = moduleInfo(subject, m)!, b = moduleInfo(subject, needs)!
      return { ok: false, error: `${a.fr} nécessite ${b.fr} / ${a.en} needs ${b.en}` }
    }
  }
  return { ok: true, modules: known.filter(x => set.has(x)) }
}

// The refusal every gate returns: 403, reason module_off.
export function moduleOffText(subject: ModuleSubject, m: string): string {
  const i = moduleInfo(subject, m)
  return i
    ? `Module « ${i.fr} » non activé pour ce ${subject === 'restaurant' ? 'restaurant' : 'compte'} / "${i.en}" module not enabled for this ${subject === 'restaurant' ? 'restaurant' : 'account'}`
    : 'Module non activé / Module not enabled'
}

// ── What a restaurant's modules allow (M2). Client-safe, so pages and APIs
//    agree. `modules` is restaurants.modules. ──────────────────────────────
type WithModules = { modules?: string[] | null }

export function hasModule(r: WithModules | null | undefined, m: string): boolean {
  return !!r?.modules?.includes(m)
}

// Cart + orders (else the Vitrine: menu with prices, WhatsApp / call buttons).
export function takesOrders(r: WithModules | null | undefined): boolean {
  return hasModule(r, 'orders')
}

// Delivery offered to customers: the module AND the restaurant's own switch.
export function deliversNow(r: (WithModules & { delivery_enabled?: boolean | null }) | null | undefined): boolean {
  return takesOrders(r) && hasModule(r, 'delivery') && r?.delivery_enabled === true
}

// The payment mode customers get: the restaurant's setting, but pay-at-pickup
// only without the Paiement module (the setting is kept for when it returns).
export function effectiveRestaurantMode(r: (WithModules & { payment_mode?: string | null; payment_enabled?: boolean | null }) | null | undefined): PaymentMode {
  if (!hasModule(r, 'payment')) return 'reservation_only'
  return normalizeMode(r?.payment_mode ?? modeFromLegacy(r?.payment_enabled))
}
