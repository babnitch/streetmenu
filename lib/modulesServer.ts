// Server-only: read, check and change a pro's modules (M1).
//
// Every gate goes through requireRestaurantModule / requireOrganizerModule,
// which answer 403 { reason: 'module_off' } with the FR/EN text. Changes go
// through setRestaurantModules / setOrganizerModules: validated, audited
// (before → after), and kept in sync with the two older flags that other
// code still reads until it moves to modules:
//   broadcast    ↔ restaurants.broadcast_enabled / customers.broadcast_enabled
//   auto_approve ↔ customers.event_auto_approve

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { managedWithoutContact, NO_ORDER_CONTACT_TEXT } from '@/lib/managedRestaurant'
import {
  validateModules, moduleOffText, toggleModule,
  type RestaurantModule, type OrganizerModule, type ModuleSubject,
} from '@/lib/modules'

// N3: a managed restaurant with no order contact never has Commandes (nor
// the modules that need it), whatever the column says — so every gate below
// refuses its orders and payments.
export async function restaurantModules(restaurantId: string): Promise<string[]> {
  const { data } = await supabaseAdmin.from('restaurants').select('modules, managed_by_platform').eq('id', restaurantId).maybeSingle()
  const list = (data?.modules as string[] | null) ?? []
  if (data?.managed_by_platform === true && list.includes('orders') && await managedWithoutContact(restaurantId, true)) {
    return toggleModule('restaurant', list, 'orders', false)
  }
  return list
}

export async function organizerModules(customerId: string): Promise<string[]> {
  const { data } = await supabaseAdmin.from('customers').select('organizer_modules').eq('id', customerId).maybeSingle()
  return (data?.organizer_modules as string[] | null) ?? []
}

export async function hasRestaurantModule(restaurantId: string, m: RestaurantModule): Promise<boolean> {
  return (await restaurantModules(restaurantId)).includes(m)
}

export async function hasOrganizerModule(customerId: string | null | undefined, m: OrganizerModule): Promise<boolean> {
  if (!customerId) return false
  return (await organizerModules(customerId)).includes(m)
}

export function moduleOffResponse(subject: ModuleSubject, m: string): NextResponse {
  return NextResponse.json({ error: moduleOffText(subject, m), reason: 'module_off', module: m }, { status: 403 })
}

// null when allowed, else the 403 to return.
export async function requireRestaurantModule(restaurantId: string, m: RestaurantModule): Promise<NextResponse | null> {
  return (await hasRestaurantModule(restaurantId, m)) ? null : moduleOffResponse('restaurant', m)
}

export async function requireOrganizerModule(customerId: string | null | undefined, m: OrganizerModule): Promise<NextResponse | null> {
  return (await hasOrganizerModule(customerId, m)) ? null : moduleOffResponse('organizer', m)
}

export interface Actor { id: string; type: string }
export type SetModulesResult =
  | { ok: true; before: string[]; after: string[] }
  | { ok: false; status: number; error: string }

export async function setRestaurantModules(restaurantId: string, raw: unknown, actor: Actor, reason = 'admin'): Promise<SetModulesResult> {
  const v = validateModules('restaurant', raw)
  if (!v.ok) return { ok: false, status: 400, error: v.error }
  const { data: row } = await supabaseAdmin.from('restaurants').select('id, modules, managed_by_platform').eq('id', restaurantId).maybeSingle()
  if (!row) return { ok: false, status: 404, error: 'Restaurant introuvable / Restaurant not found' }
  const before = (row.modules as string[] | null) ?? []
  const after = v.modules
  // N3: Commandes on a managed restaurant needs someone to receive orders.
  if (row.managed_by_platform === true && after.includes('orders') && await managedWithoutContact(restaurantId, true)) {
    return { ok: false, status: 409, error: NO_ORDER_CONTACT_TEXT }
  }
  const { error } = await supabaseAdmin.from('restaurants')
    .update({ modules: after, broadcast_enabled: after.includes('broadcast') })
    .eq('id', restaurantId)
  if (error) return { ok: false, status: 500, error: error.message }
  if (!sameSet(before, after)) {
    await writeAudit({
      action: 'modules_updated', targetType: 'restaurant', targetId: restaurantId,
      performedBy: actor.id, performedByType: actor.type,
      previousData: { modules: before }, metadata: { modules: after, reason, ...diff(before, after) },
    })
  }
  return { ok: true, before, after }
}

export async function setOrganizerModules(customerId: string, raw: unknown, actor: Actor, reason = 'admin'): Promise<SetModulesResult> {
  const v = validateModules('organizer', raw)
  if (!v.ok) return { ok: false, status: 400, error: v.error }
  const { data: row } = await supabaseAdmin.from('customers').select('id, organizer_modules').eq('id', customerId).maybeSingle()
  if (!row) return { ok: false, status: 404, error: 'Compte introuvable / Account not found' }
  const before = (row.organizer_modules as string[] | null) ?? []
  const after = v.modules
  const { error } = await supabaseAdmin.from('customers')
    .update({
      organizer_modules: after,
      broadcast_enabled: after.includes('broadcast'),
      event_auto_approve: after.includes('auto_approve'),
    })
    .eq('id', customerId)
  if (error) return { ok: false, status: 500, error: error.message }
  if (!sameSet(before, after)) {
    await writeAudit({
      action: 'modules_updated', targetType: 'customer', targetId: customerId,
      performedBy: actor.id, performedByType: actor.type,
      previousData: { organizer_modules: before }, metadata: { organizer_modules: after, reason, ...diff(before, after) },
    })
  }
  return { ok: true, before, after }
}

// Turn one module on or off, keeping the rest (and the dependencies valid).
export async function switchModule(subject: ModuleSubject, id: string, m: string, on: boolean, actor: Actor, reason: string): Promise<SetModulesResult> {
  const current = subject === 'restaurant' ? await restaurantModules(id) : await organizerModules(id)
  const next = toggleModule(subject, current, m, on)
  return subject === 'restaurant'
    ? setRestaurantModules(id, next, actor, reason)
    : setOrganizerModules(id, next, actor, reason)
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every(x => b.includes(x))
}
function diff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  return { added: after.filter(x => !before.includes(x)), removed: before.filter(x => !after.includes(x)) }
}

// ── Events (M4): an event follows its organiser's modules. An event with no
//    organiser account (old rows) keeps working as before modules existed. ──
export async function eventAllows(event: { organizer_id?: string | null }, m: OrganizerModule): Promise<boolean> {
  if (!event.organizer_id) return true
  return (await organizerModules(event.organizer_id)).includes(m)
}

export async function requireEventModule(event: { organizer_id?: string | null }, m: OrganizerModule): Promise<NextResponse | null> {
  return (await eventAllows(event, m)) ? null : moduleOffResponse('organizer', m)
}
