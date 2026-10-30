// M1 — modules per pro: data, admin switches, approve + activate.
//
// /api/admin/modules (GET/PUT): admin only, names and dependencies checked,
// audited, broadcast/auto_approve flags kept in step. Restaurant approval and
// a first-event approval take the modules from the approval screen. New
// restaurants start with the Vitrine only. The old broadcast / auto-approve
// switches move the modules too.
//
// Every phone is +999; events use a per-run city (no subscriber fan-out).

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeEvent, testPictureUrl } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { validateModules, toggleModule } from '../../lib/modules'

const SUITE = 'api-modules-m1'
const CITY = testName('city')

async function mods(table: 'restaurants' | 'customers', id: string): Promise<{ list: string[]; row: Record<string, unknown> }> {
  const col = table === 'restaurants' ? 'modules, broadcast_enabled' : 'organizer_modules, broadcast_enabled, event_auto_approve'
  const { data } = await sb.from(table).select(col).eq('id', id).single()
  const row = data as unknown as Record<string, unknown>
  return { list: (row[table === 'restaurants' ? 'modules' : 'organizer_modules'] as string[]) ?? [], row }
}

async function main(): Promise<void> {
  try {
    await step('rules: names, dependencies, ticking/unticking', async () => {
      assert(validateModules('restaurant', ['payment', 'orders']).ok, 'payment with orders → ok')
      const bad = validateModules('restaurant', ['payment'])
      assert(!bad.ok && /Commandes/.test(bad.ok ? '' : bad.error), 'payment without orders → refused, says Commandes')
      assert(!validateModules('restaurant', ['nope']).ok, 'unknown name → refused')
      assert(!validateModules('organizer', ['paid_tickets']).ok, 'paid tickets without bookings → refused')
      assertEq(toggleModule('restaurant', [], 'delivery', true), ['orders', 'delivery'], 'ticking Livraison ticks Commandes')
      assertEq(toggleModule('restaurant', ['orders', 'payment', 'delivery', 'team'], 'orders', false), ['team'], 'unticking Commandes drops Paiement and Livraison')
    })

    const admin = await adminCookie()
    const owner = await makeCustomer({ suiteNo: 71, name: 'Modules Owner' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'mod_r', whatsapp: owner.phone })

    await step('admin API: admin only; checked; saved, audited, broadcast in step', async () => {
      assertEq((await api('/api/admin/modules', { method: 'PUT', cookie: customerCookie(owner), body: { subject: 'restaurant', id: rest.id, modules: ['orders'] } })).status, 401, 'a customer → 401')
      const bad = await api<{ error?: string }>('/api/admin/modules', { method: 'PUT', cookie: admin, body: { subject: 'restaurant', id: rest.id, modules: ['payment'] } })
      assertEq(bad.status, 400, 'payment without orders → 400')
      const ok = await api<{ modules?: string[] }>('/api/admin/modules', { method: 'PUT', cookie: admin, body: { subject: 'restaurant', id: rest.id, modules: ['broadcast', 'orders', 'payment'] } })
      assertEq(ok.status, 200, `saved (${ok.raw.slice(0, 120)})`)
      assertEq(ok.body.modules, ['orders', 'payment', 'broadcast'], 'canonical order back')
      const m = await mods('restaurants', rest.id)
      assertEq(m.list, ['orders', 'payment', 'broadcast'], 'stored')
      assertEq(m.row.broadcast_enabled, true, 'broadcast_enabled follows the module')
      const { data: audit } = await sb.from('audit_log').select('id, action').eq('target_id', rest.id).eq('action', 'modules_updated')
      assert((audit ?? []).length >= 1, 'audit row written')
      const get = await api<{ modules?: string[] }>(`/api/admin/modules?subject=restaurant&id=${rest.id}`, { cookie: admin })
      assertEq(get.body.modules, ['orders', 'payment', 'broadcast'], 'GET reads it back')
    })

    await step('old Diffusion switch moves the module', async () => {
      const r = await api(`/api/admin/restaurants/${rest.id}/broadcast`, { method: 'PATCH', cookie: admin, body: { broadcast_enabled: false } })
      assertEq(r.status, 200, 'switch off → 200')
      const m = await mods('restaurants', rest.id)
      assert(!m.list.includes('broadcast') && m.row.broadcast_enabled === false, 'module and flag both off')
    })

    await step('new restaurants start with the Vitrine only', async () => {
      const fresh = await makeCustomer({ suiteNo: 71, name: 'Modules Signup' })
      const r = await api<{ restaurant_id?: string; id?: string }>('/api/restaurants/submit', {
        cookie: customerCookie(fresh),
        body: { name: testName('mod_signup'), city: 'Yaoundé', neighborhood: 'Bastos', cuisine_type: 'Camerounaise', image_url: testPictureUrl() },
      })
      assertEq(r.status, 200, `web sign-up → 200 (${r.raw.slice(0, 120)})`)
      const { data } = await sb.from('restaurants').select('id, modules').eq('customer_id', fresh.id).maybeSingle()
      if (data?.id) track('restaurants', data.id as string)
      assertEq((data?.modules as string[] | undefined) ?? null, [], 'no modules')
    })

    await step('restaurant approval: approve + activate in one step', async () => {
      const pending = await makeRestaurant({ label: 'mod_pending', isActive: false, status: 'pending' })
      const bad = await api(`/api/restaurants/${pending.id}/approve`, { method: 'POST', cookie: admin, body: { modules: ['delivery'] } })
      assertEq(bad.status, 400, 'invalid list → 400')
      const { data: still } = await sb.from('restaurants').select('status').eq('id', pending.id).single()
      assertEq((still as { status: string }).status, 'pending', 'and nothing approved')
      const ok = await api(`/api/restaurants/${pending.id}/approve`, { method: 'POST', cookie: admin, body: { modules: ['orders', 'delivery'] } })
      assertEq(ok.status, 200, `approve with modules → 200 (${ok.raw.slice(0, 120)})`)
      const { data } = await sb.from('restaurants').select('status, modules').eq('id', pending.id).single()
      const row = data as { status: string; modules: string[] }
      assert(row.status === 'active' && row.modules.join() === 'orders,delivery', 'active with Commandes + Livraison')
    })

    await step('admin "new restaurant" takes the modules too', async () => {
      const r = await api<{ restaurant?: { id: string; modules?: string[] } }>('/api/admin/restaurants', {
        cookie: admin,
        body: { name: testName('mod_admin'), city: testName('city'), lat: 3.87, lng: 11.52, logo_url: testPictureUrl(),
          owner_phone: (await makeCustomer({ suiteNo: 71, name: 'Modules Admin Owner' })).phone, modules: ['orders'] },
      })
      if (r.body.restaurant?.id) track('restaurants', r.body.restaurant.id)
      assertEq(r.status, 200, `created (${r.raw.slice(0, 120)})`)
      assertEq(r.body.restaurant?.modules, ['orders'], 'with Commandes')
    })

    await step('first event approval: organiser gets the screen\'s modules', async () => {
      const org = await makeCustomer({ suiteNo: 71, name: 'Modules Organiser', extra: { event_auto_approve: false } })
      const ev = await makeEvent({ organizerId: org.id, label: 'mod_event', city: CITY, isActive: false })
      const r = await api(`/api/admin/events/${ev.id}/approve`, { method: 'POST', cookie: admin, body: { modules: ['reservations', 'ticket_control'] } })
      assertEq(r.status, 200, `approve → 200 (${r.raw.slice(0, 120)})`)
      assertEq((await mods('customers', org.id)).list, ['reservations', 'ticket_control'], 'Réservations + Contrôle')
    })

    await step('auto-approval earned at the 3rd event becomes the module; revoking removes it', async () => {
      const org = await makeCustomer({ suiteNo: 71, name: 'Modules Trusted', extra: { event_auto_approve: false, events_approved_count: 2, organizer_modules: ['reservations'] } })
      const ev = await makeEvent({ organizerId: org.id, label: 'mod_event3', city: CITY, isActive: false })
      assertEq((await api(`/api/admin/events/${ev.id}/approve`, { method: 'POST', cookie: admin })).status, 200, 'approve → 200')
      let m = await mods('customers', org.id)
      assert(m.list.includes('auto_approve') && m.list.includes('reservations') && m.row.event_auto_approve === true, 'auto_approve added, reservations kept, flag on')
      const rv = await api(`/api/admin/events/revoke-auto-approve/${org.id}`, { method: 'POST', cookie: admin, body: {} })
      assertEq(rv.status, 200, 'revoke → 200')
      m = await mods('customers', org.id)
      assert(!m.list.includes('auto_approve') && m.row.event_auto_approve === false, 'module and flag both off')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
