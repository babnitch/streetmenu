// Client / Pro navigation (lib/navConfig.ts). Pure: no server, no DB.
//
// Pro mode is open to every logged-in customer. Orders needs a restaurant;
// the restaurant's own tools are gated by the viewer's role there.

import { navFor, restaurantToolsFor } from '@/lib/navConfig'
import { safeReturnPath, loginHref } from '@/lib/lastPhone'
import { assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-nav-modes'
const keys = (mode: 'client' | 'pro', role: 'owner' | 'manager' | 'staff' | null, hasRestaurant: boolean) =>
  navFor(mode, role, hasRestaurant).map(d => d.key)

async function main(): Promise<void> {
  await step('client mode is the same for everyone', () => {
    const client = ['restaurants', 'events', 'search', 'cart', 'account']
    assertEq(keys('client', null, false), client, 'customer')
    assertEq(keys('client', 'owner', true), client, 'restaurant owner')
  })

  await step('Pro without a restaurant: My restaurants, My events, Account', () => {
    assertEq(keys('pro', null, false), ['myRestaurants', 'myEvents', 'account'], 'no Orders')
  })

  await step('Pro with a restaurant: Orders first, for every role', () => {
    for (const role of ['owner', 'manager', 'staff'] as const) {
      assertEq(keys('pro', role, true), ['orders', 'myRestaurants', 'myEvents', 'account'], role)
    }
  })

  await step('restaurant tools follow the role', () => {
    const tools = (r: Parameters<typeof restaurantToolsFor>[0]) => restaurantToolsFor(r).map(t => t.key)
    assertEq(tools('staff'), ['orders', 'validate'], 'staff: orders + validate')
    assertEq(tools('manager'), ['orders', 'menu', 'vouchers', 'validate', 'settings'], 'manager: no Team')
    assertEq(tools('owner'), ['orders', 'menu', 'vouchers', 'validate', 'settings', 'team'], 'owner: everything')
    assertEq(tools('admin'), tools('owner'), 'platform admin = owner')
    assertEq(tools(null), ['orders', 'validate'], 'no role: the floor tools only')
  })

  await step('login return path: same-site only, never the login screen', () => {
    assertEq(safeReturnPath('/events/abc?reserve=1'), '/events/abc?reserve=1', 'a site path is kept')
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', '/login', '/login?return=/x', '/admin/login', '', null]) {
      assertEq(safeReturnPath(bad as string | null), null, `${JSON.stringify(bad)} refused`)
    }
    assertEq(loginHref('/order'), '/login?return=%2Forder', 'gate link encodes the return path')
  })

  finish(SUITE)
}

void main()
