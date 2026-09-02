// Single source of truth for the app's navigation destinations.
//
// Both nav surfaces (the mobile BottomNav and the desktop TopNav) will
// render from this module, so the two can't drift the way they have. It is
// DATA + PURE HELPERS ONLY: no React, no JSX, no imports that pull runtime
// code out of a 'use client' module. The two imports below are `import
// type`, erased at compile time.
//
// Nothing renders from this yet — it is introduced ahead of the nav rework
// so the destination sets can be reviewed on their own.
//
// ── Two deliberate differences from what ships today ──────────────────────
//
//  1. The restaurant set has FOUR entries. The live BottomNav renders a
//     fifth, "Mes événements" → /account?tab=events. Event organizing is an
//     Account feature, not a mode, so it is not modelled here.
//  2. The desktop TopNav additionally renders Vouchers, Settings and the
//     public Restaurants/Events links while in restaurant mode. Those are
//     not modelled here either.
//
// Both resolve when the nav bars are rewired to read from this module.

import type { DashboardTab, TeamRole, RoleRankShape } from './modeContext'

export type NavMode   = 'client' | 'restaurant'
/** Behaviour the renderer owns, rather than a route change. */
export type NavAction = 'openSearch'
/** Count the renderer supplies; the config only names which one. */
export type NavBadge  = 'pendingOrders' | 'cartCount'

export type NavKey =
  | 'restaurants' | 'events' | 'search' | 'cart' | 'account'
  | 'orders' | 'menu'

export interface NavDestination {
  key:     NavKey
  icon:    string
  labelFr: string
  labelEn: string

  /** Route target. Mutually exclusive with `actionKey` in practice. */
  href?: string

  /** Renderer-owned behaviour instead of a route change (the search
   *  overlay). See the note on `match` below. */
  actionKey?: NavAction

  /** Set alongside `href: '/dashboard'`. The renderer must flip this
   *  through ModeContext and only then route, because Next.js treats
   *  /dashboard?tab=a and ?tab=b as the same route and skips the
   *  re-render — which is why the tab lives in context at all. */
  dashboardTab?: DashboardTab

  /** MINIMUM team tier required to see this destination, on the
   *  staff < manager < owner ladder. Absent = visible to every tier.
   *  Resolve with `meetsRole()`, never by equality. */
  minRole?: TeamRole

  badgeKey?: NavBadge

  /** Active-state test. Pure by design, so it can only see the route and
   *  the dashboard tab.
   *
   *  A destination carrying an `actionKey` has its active state owned by
   *  the RENDERER (the search overlay's open flag is component state, not
   *  route state), so its `match` returns false and the renderer ORs in
   *  its own flag. */
  match: (pathname: string, dashboardTab: DashboardTab) => boolean
}

// ── Role ladder ─────────────────────────────────────────────────────────────
// Local copy so this module stays free of runtime imports. It MUST stay in
// step with ROLE_RANK in lib/modeContext.tsx — the `_RankLaddersMatch`
// assertion below fails `tsc` if the two ever diverge, so a drift can't ship
// silently.
const NAV_ROLE_RANK = { staff: 1, manager: 2, owner: 3 } as const

// Structural equality check between the two ladders. `Equal` is the standard
// conditional-type identity trick; `Expect` only accepts `true`, so a
// mismatch in keys OR in literal values is a compile error at this line.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T
export type _RankLaddersMatch = Expect<Equal<typeof NAV_ROLE_RANK, RoleRankShape>>

/** Does `topRole` clear the `min` bar? No bar → always true. No role → only
 *  destinations with no bar. Admins hold `topRole: null` but are forced to
 *  client mode upstream, so they never reach a `minRole` destination. */
export function meetsRole(topRole: TeamRole | null, min?: TeamRole): boolean {
  if (!min) return true
  if (!topRole) return false
  return NAV_ROLE_RANK[topRole] >= NAV_ROLE_RANK[min]
}

// ── Destination sets ────────────────────────────────────────────────────────
// Order is the render order. Match bodies mirror the live BottomNav so
// rewiring is a swap, not a behaviour change.

const CLIENT_NAV: readonly NavDestination[] = [
  {
    key: 'restaurants', icon: '🏠',
    // Same word in both locales — kept explicit rather than special-cased.
    labelFr: 'Restaurants', labelEn: 'Restaurants',
    href: '/',
    match: p => p === '/' || p.startsWith('/restaurant'),
  },
  {
    key: 'events', icon: '🎉',
    labelFr: 'Événements', labelEn: 'Events',
    href: '/events',
    // Public browsing. The organizer's own events are an Account feature
    // and deliberately have no tab in either set.
    match: p => p.startsWith('/events'),
  },
  {
    key: 'search', icon: '🔍',
    labelFr: 'Recherche', labelEn: 'Search',
    actionKey: 'openSearch',
    match: () => false,
  },
  {
    key: 'cart', icon: '🛒',
    labelFr: 'Panier', labelEn: 'Cart',
    href: '/order',
    badgeKey: 'cartCount',
    match: p => p === '/order',
  },
  {
    key: 'account', icon: '👤',
    labelFr: 'Compte', labelEn: 'Account',
    href: '/account',
    match: p => p === '/account',
  },
] as const

const RESTAURANT_NAV: readonly NavDestination[] = [
  {
    key: 'orders', icon: '📦',
    labelFr: 'Commandes', labelEn: 'Orders',
    href: '/dashboard', dashboardTab: 'orders',
    badgeKey: 'pendingOrders',
    // Catches every dashboard tab except Menu, so a freshly-loaded
    // /dashboard still highlights something.
    match: (p, tab) => p.startsWith('/dashboard') && tab !== 'menu',
  },
  {
    key: 'menu', icon: '🍽️',
    labelFr: 'Menu', labelEn: 'Menu',
    href: '/dashboard', dashboardTab: 'menu',
    // Manager or owner. Staff get a view-only surface later, not the editor.
    minRole: 'manager',
    match: (p, tab) => p.startsWith('/dashboard') && tab === 'menu',
  },
  {
    key: 'search', icon: '🔍',
    labelFr: 'Recherche', labelEn: 'Search',
    actionKey: 'openSearch',
    match: () => false,
  },
  {
    key: 'account', icon: '👤',
    labelFr: 'Compte', labelEn: 'Account',
    href: '/account',
    match: p => p === '/account',
  },
] as const

export const NAV: Record<NavMode, readonly NavDestination[]> = {
  client:     CLIENT_NAV,
  restaurant: RESTAURANT_NAV,
}

/** The destinations a viewer in `mode` holding `topRole` should see, in
 *  render order. Pass the mode already resolved through the
 *  hasRestaurantRole gate (ModeContext exposes it as `effectiveMode`). */
export function navFor(mode: NavMode, topRole: TeamRole | null): NavDestination[] {
  return NAV[mode].filter(d => meetsRole(topRole, d.minRole))
}

/** Locale-picked label, so callers don't repeat the ternary. */
export function navLabel(d: NavDestination, locale: string): string {
  return locale === 'en' ? d.labelEn : d.labelFr
}
