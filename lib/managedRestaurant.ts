// Admin-managed restaurants (N3). Server-only.
//
// A restaurant the admin lists with no owner is "managed by Tchop & Ndjoka"
// (restaurants.managed_by_platform). It is published as a Vitrine: info,
// menu, photos, WhatsApp / Call buttons. It can take orders or payments only
// once it has an ORDER CONTACT — a number in restaurant_order_phones or an
// active team member — AND the admin has switched Commandes on.
//
// The rule is enforced in one place for reads (restaurantModules strips the
// order modules while a managed restaurant has no contact, so every module
// gate — order API, payment API, the bot — refuses) and one for writes
// (setRestaurantModules refuses to switch Commandes on without a contact).

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { normalizePhone } from '@/lib/phone'

export const NO_ORDER_CONTACT_TEXT =
  'Ajoutez d\'abord un numéro de commande ou un membre de l\'équipe / Add an order number or a team member first'
export const LAST_CONTACT_TEXT =
  'C\'est le dernier contact de commande : coupez d\'abord Commandes / This is the last order contact: switch Orders off first'

export async function orderPhones(restaurantId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('restaurant_order_phones').select('phone')
    .eq('restaurant_id', restaurantId).order('created_at', { ascending: true })
  return ((data ?? []) as Array<{ phone: string }>).map(r => r.phone)
}

// Order numbers + active team members (any role).
export async function orderContactCount(restaurantId: string): Promise<number> {
  const [{ count: phones }, { count: team }] = await Promise.all([
    supabaseAdmin.from('restaurant_order_phones').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId),
    supabaseAdmin.from('restaurant_team').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId).eq('status', 'active'),
  ])
  return (phones ?? 0) + (team ?? 0)
}

export async function isManaged(restaurantId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from('restaurants').select('managed_by_platform').eq('id', restaurantId).maybeSingle()
  return data?.managed_by_platform === true
}

// True when orders must be refused: managed and nobody to receive them.
export async function managedWithoutContact(restaurantId: string, managed?: boolean | null): Promise<boolean> {
  const m = managed ?? await isManaged(restaurantId)
  if (!m) return false
  return (await orderContactCount(restaurantId)) === 0
}

// Of these restaurant ids, the ones that may not take orders (bot lists).
export async function blockedForOrders(ids: string[]): Promise<Set<string>> {
  const blocked = new Set<string>()
  if (ids.length === 0) return blocked
  const { data } = await supabaseAdmin.from('restaurants').select('id').in('id', ids).eq('managed_by_platform', true)
  for (const r of (data ?? []) as Array<{ id: string }>) {
    if (await managedWithoutContact(r.id, true)) blocked.add(r.id)
  }
  return blocked
}

export function validOrderPhone(raw: unknown): string | null {
  const p = normalizePhone(typeof raw === 'string' ? raw : '')
  return /^\+\d{8,15}$/.test(p) ? p : null
}

