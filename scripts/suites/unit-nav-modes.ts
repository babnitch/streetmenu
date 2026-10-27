// Client / Pro navigation (lib/navConfig.ts). Pure: no server, no DB.
//
// Pro mode is open to every logged-in customer. Its restaurant destinations
// (Orders, Menu) need a restaurant; without one the Pro home takes their
// place. Menu also needs manager or above.

import { navFor } from '@/lib/navConfig'
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

  await step('Pro without a restaurant: Pro home, My events, Account', () => {
    assertEq(keys('pro', null, false), ['proHome', 'myEvents', 'account'], 'no Orders, no Menu')
  })

  await step('Pro with a restaurant: Orders first, Menu for manager and above', () => {
    assertEq(keys('pro', 'owner', true), ['orders', 'menu', 'myEvents', 'account'], 'owner')
    assertEq(keys('pro', 'manager', true), ['orders', 'menu', 'myEvents', 'account'], 'manager')
    assertEq(keys('pro', 'staff', true), ['orders', 'myEvents', 'account'], 'staff: no Menu')
  })

  finish(SUITE)
}

void main()
