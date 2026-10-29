// Client / Pro separated — the rules (lib/modeSurfaces) for every entry
// point in both modes, and a source scan: the app mode changes only in
// lib/useSwitchMode (ModeToggle + the ModeGate button) and on sign-out.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { pageMode, accountItems, sideMenuItems, showProAlerts, showCustomerBadges, type ModeFlags, type AccountItem, type SideItem } from '@/lib/modeSurfaces'
import { navFor } from '@/lib/navConfig'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-mode-surfaces'
const NONE: ModeFlags = { hasRestaurant: false, isOwner: false, checksEvents: false, isRider: false, canPromote: false, canBroadcast: false }
const ALL: ModeFlags = { hasRestaurant: true, isOwner: true, checksEvents: true, isRider: true, canPromote: true, canBroadcast: true }

const CLIENT_ONLY_ACCOUNT: AccountItem[] = ['orders', 'bookings', 'vouchers', 'favorites', 'profile', 'notifications']
const PRO_ONLY_ACCOUNT: AccountItem[] = ['restaurantTools', 'myRestaurant', 'team', 'myEvents', 'createEvent', 'doorCheck', 'deliveries', 'proProfile', 'modules', 'promote', 'broadcast', 'addRestaurant']
const CLIENT_ONLY_SIDE: SideItem[] = ['myOrders', 'myBookings', 'myFavorites', 'proSpace']
const PRO_ONLY_SIDE: SideItem[] = ['restaurantOrders', 'myEvents', 'doorCheck', 'deliveries', 'addRestaurant', 'addEventOrPlace']

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?)$/.test(f)) out.push(p)
  }
  return out
}

async function main(): Promise<void> {
  await step('which pages belong to which mode', () => {
    for (const p of ['/pro', '/pro/events', '/pro/profile', '/pro/restaurants', '/pro/restaurants/new', '/dashboard', '/scanner', '/livraisons', '/events/submit']) {
      assertEq(pageMode(p), 'pro', `${p} → Pro`)
    }
    assertEq(pageMode('/scanner', '?event=abc'), 'pro', 'door-staff link → Pro')
    for (const t of ['orders', 'bookings', 'vouchers', 'favorites']) assertEq(pageMode('/account', `?tab=${t}`), 'client', `/account?tab=${t} → Client`)
    for (const p of ['/', '/restaurants', '/restaurant/x', '/events', '/events/abc', '/order', '/scan/AbC_dEf', '/contact', '/account', '/login', '/admin/restaurants']) {
      assertEq(pageMode(p), 'any', `${p} → both`)
    }
    assertEq(pageMode('/account', '?tab=profile'), 'any', 'account profile → both (the page shows the mode\'s list)')
    assertEq(pageMode('/professional'), 'any', 'a path that only starts with "pro" is not Pro')
  })

  await step('account page: each mode lists only its own items', () => {
    for (const f of [NONE, ALL]) {
      const c = accountItems('client', f), p = accountItems('pro', f)
      assert(!c.some(i => PRO_ONLY_ACCOUNT.includes(i)), 'client: no pro item')
      assert(!p.some(i => CLIENT_ONLY_ACCOUNT.includes(i)), 'pro: no client item')
      for (const both of ['language', 'lowData', 'modeSwitch', 'signOut'] as const) assert(c.includes(both) && p.includes(both), `${both} in both`)
    }
    assertEq(accountItems('client', ALL).slice(0, 6), ['orders', 'bookings', 'vouchers', 'favorites', 'profile', 'notifications'], 'client list')
    assert(!accountItems('pro', NONE).includes('restaurantTools') && !accountItems('pro', NONE).includes('doorCheck'), 'pro without restaurant / events to check')
    assert(['restaurantTools', 'team', 'doorCheck', 'deliveries', 'promote', 'broadcast'].every(i => accountItems('pro', ALL).includes(i as AccountItem)), 'pro with everything')
  })

  await step('☰: each mode lists only its own rows; logged out = client + Espace Pro', () => {
    for (const f of [NONE, ALL]) {
      assert(!sideMenuItems('client', true, f).some(i => PRO_ONLY_SIDE.includes(i)), 'client: no pro row')
      assert(!sideMenuItems('pro', true, f).some(i => CLIENT_ONLY_SIDE.includes(i)), 'pro: no client row')
    }
    assertEq(sideMenuItems('client', false, ALL), ['signup', 'login', 'proSpace', 'lowData', 'language'], 'logged out')
    assert(sideMenuItems('client', true, NONE).includes('proSpace'), 'client: Espace Pro')
    assert(sideMenuItems('pro', true, ALL).includes('restaurantOrders') && !sideMenuItems('pro', true, NONE).includes('restaurantOrders'), 'restaurant orders only with a restaurant')
  })

  await step('bottom bar / header and badges follow the mode', () => {
    assertEq(navFor('client', 'owner', true).map(d => d.key), ['restaurants', 'events', 'cart', 'account'], 'client bar (even for an owner)')
    assert(!navFor('pro', 'owner', true).some(d => d.key === 'cart'), 'pro bar: no cart')
    assert(!navFor('client', 'owner', true).some(d => d.badgeKey === 'pendingOrders'), 'client bar: no pending-orders badge')
    assertEq([showProAlerts('client'), showProAlerts('pro')], [false, true], 'pro alerts in Pro only')
    assertEq([showCustomerBadges('client'), showCustomerBadges('pro')], [true, false], 'customer badges in Client only')
  })

  await step('source: the mode changes only through the switch / the gate button', () => {
    const offenders: string[] = []
    for (const file of [...walk('app'), ...walk('components')]) {
      const src = readFileSync(file, 'utf8')
      if (/\{[^}]*\bsetMode\b[^}]*\}\s*=\s*useMode\(\)/.test(src)) offenders.push(file)
    }
    assertEq(offenders, [], 'nobody takes setMode from useMode() in app/ or components/ (use lib/useSwitchMode)')
    const login = readFileSync('app/login/page.tsx', 'utf8')
    assert(/intent'\) === 'pro'\) persistMode\('pro'\)/.test(login), 'only the explicit Pro login keeps opening in Pro')
  })

  finish(SUITE)
}

void main()
