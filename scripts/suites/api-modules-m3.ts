// M3 — the other restaurant modules, on the server.
//
// Équipe (add / invite), Codes promo (create; the restaurant's own codes stop
// working when the module is off, platform codes don't), Offre du jour
// (publish; live offers stop applying), Diffusion (eligibility from the
// module, not the old flag), Mise en avant (buying a placement). Every
// refusal is 403 reason module_off.
//
// Every phone is +999.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem, makeVoucher } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'
import { validateVoucher } from '../../lib/vouchers'
import { loadRestaurantOffersToday } from '../../lib/offersServer'
import { getBroadcastEligibility } from '../../lib/subscriptions'
import { dateInZone } from '../../lib/offers'

const SUITE = 'api-modules-m3'

interface Body { ok?: boolean; reason?: string; error?: string }

async function main(): Promise<void> {
  try {
    const owner = await makeCustomer({ suiteNo: 73, name: 'M3 Owner' })
    const friend = await makeCustomer({ suiteNo: 73, name: 'M3 Friend' })
    const oc = customerCookie(owner)
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'm3_r', whatsapp: owner.phone, modules: ['orders'], extra: { timezone: 'Africa/Douala' } })
    const dish = await makeMenuItem(rest.id, { price: 3000 })
    const setModules = (m: string[]) => sb.from('restaurants').update({ modules: m }).eq('id', rest.id)

    await step('Équipe: adding and inviting need the module', async () => {
      const add = await api<Body>(`/api/restaurants/${rest.id}/team`, { cookie: oc, body: { phone: friend.phone, role: 'staff' } })
      assertEq(add.status, 403, 'add → 403')
      assertEq(add.body.reason, 'module_off', 'reason module_off')
      const inv = await api<Body>(`/api/restaurants/${rest.id}/invite`, { cookie: oc, body: { phone: friend.phone, role: 'staff' } })
      assertEq(inv.status, 403, 'invite → 403')
      await setModules(['orders', 'team'])
      const ok = await api<Body>(`/api/restaurants/${rest.id}/invite`, { cookie: oc, body: { phone: friend.phone, role: 'staff' } })
      assert(ok.status === 200 || ok.status === 201, `with Équipe → added (${ok.status} ${ok.raw.slice(0, 100)})`)
      await sb.from('restaurant_team').delete().eq('restaurant_id', rest.id).eq('customer_id', friend.id)
      await sb.from('team_invitations').delete().eq('restaurant_id', rest.id)
    })

    await step('Codes promo: creating needs the module; its codes stop when it\'s off', async () => {
      await setModules(['orders'])
      const c = await api<Body>('/api/vendor/vouchers', { cookie: oc, body: { restaurant_id: rest.id, code: 'M3TEST', discount_type: 'percent', discount_value: 10 } })
      assertEq(c.status, 403, 'create → 403')
      const v = await makeVoucher({ label: 'm3code', restaurantId: rest.id, discountValue: 10, extra: { per_customer_max: 0 } })
      const off = await validateVoucher(v.code, { customerId: null, restaurantId: rest.id, orderTotal: 3000, city: null })
      assert(!off.ok && off.reason === 'inactive', 'restaurant code refused while the module is off')
      await setModules(['orders', 'promo_codes'])
      const on = await validateVoucher(v.code, { customerId: null, restaurantId: rest.id, orderTotal: 3000, city: null })
      assert(on.ok, 'and works again with it')
      const platform = await makeVoucher({ label: 'm3platform', discountValue: 10, extra: { per_customer_max: 0 } })
      await setModules(['orders'])
      const p = await validateVoucher(platform.code, { customerId: null, restaurantId: rest.id, orderTotal: 3000, city: null })
      assert(p.ok, 'a platform code still works without the module')
    })

    await step('Offre du jour: publishing needs the module; offers stop applying without it', async () => {
      const r = await api<Body>(`/api/restaurants/${rest.id}/offers`, { cookie: oc, body: { kind: 'price', menu_item_id: dish.id, offer_price: 2000 } })
      assertEq(r.status, 403, 'publish → 403')
      const today = dateInZone('Africa/Douala')
      await sb.from('menu_offers').insert({ restaurant_id: rest.id, menu_item_id: dish.id, kind: 'price', offer_price: 2000, starts_on: today, ends_on: today } as never)
      assertEq((await loadRestaurantOffersToday(rest.id)).prices[dish.id], undefined, 'offer ignored without the module')
      await setModules(['orders', 'daily_offer'])
      assertEq((await loadRestaurantOffersToday(rest.id)).prices[dish.id], 2000, 'applies with it')
    })

    await step('Diffusion: from the module, not the old flag', async () => {
      await sb.from('restaurants').update({ modules: ['orders'], broadcast_enabled: true }).eq('id', rest.id)
      let e = await getBroadcastEligibility(owner.id)
      assert(!e.asRestaurants.some(r => r.id === rest.id), 'flag alone → not eligible')
      await sb.from('restaurants').update({ modules: ['orders', 'broadcast'] }).eq('id', rest.id)
      e = await getBroadcastEligibility(owner.id)
      assert(e.asRestaurants.some(r => r.id === rest.id), 'module → eligible')
    })

    await step('Mise en avant: buying a placement needs the module', async () => {
      await setModules(['orders'])
      const today = new Date().toISOString().slice(0, 10)
      const r = await api<Body>('/api/promotions', { cookie: oc, body: {
        target_type: 'restaurant', target_id: rest.id, placement: 'top_list', city: 'Yaoundé',
        start_date: today, end_date: today, phone_number: '+237670000000',
      } })
      assertEq(r.status, 403, `HTTP 403 (${r.raw.slice(0, 100)})`)
      assertEq(r.body.reason, 'module_off', 'reason module_off')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
