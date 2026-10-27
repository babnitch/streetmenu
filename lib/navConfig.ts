// Single source of truth for the app's navigation destinations.
//
// Both nav surfaces (the mobile BottomNav and the desktop TopNav) will
// render from this module, so the two can't drift the way they have. It is
// DATA + PURE HELPERS ONLY: no React, no JSX, no imports that pull runtime
// code out of a 'use client' module. The two imports below are `import
// type`, erased at compile time.
//
// BottomNav and TopNav both render from navFor().
//
// Paid broadcasts are deliberately NOT a destination in either set. They are
// an admin-granted capability (restaurants/customers.broadcast_enabled),
// enforced server-side in lib/subscriptions.ts getBroadcastEligibility; the
// composer lives in Account and only renders for eligible senders.
//
// Pro mode is open to every logged-in customer:
//   📦 Commandes (only with a restaurant) · 🏪 Mes restaurants ·
//   🎉 Mes événements · 👤 Compte
// Inside a restaurant, its tools (Orders, Menu, Vouchers, Validate, Settings,
// Team) are RESTAURANT_TOOLS below, gated by the viewer's role there. The
// dashboard strip, the Account tiles and /pro/restaurants all render from it.

import type { DashboardTab, TeamRole, RoleRankShape } from './modeContext'

export type NavMode   = 'client' | 'pro'
/** Behaviour the renderer owns, rather than a route change. */
export type NavAction = 'openSearch'
/** Count the renderer supplies; the config only names which one. */
export type NavBadge  = 'pendingOrders' | 'cartCount'

export type NavKey =
  | 'restaurants' | 'events' | 'search' | 'cart' | 'account'
  | 'orders' | 'myRestaurants' | 'myEvents'

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

  /** true: only for a restaurant team member (hasRestaurantRole).
   *  false: only for someone WITHOUT a restaurant. Absent: everyone. */
  requiresRestaurant?: boolean

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
    // The list lives on /restaurants (L4); / is the landing page.
    href: '/restaurants',
    match: p => p.startsWith('/restaurant'),
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

const PRO_NAV: readonly NavDestination[] = [
  {
    key: 'orders', icon: '📦',
    labelFr: 'Commandes', labelEn: 'Orders',
    href: '/dashboard', dashboardTab: 'orders',
    badgeKey: 'pendingOrders',
    requiresRestaurant: true,
    // Every dashboard tab: the restaurant's own tool strip shows which one.
    match: p => p.startsWith('/dashboard'),
  },
  {
    key: 'myRestaurants', icon: '🏪',
    labelFr: 'Mes restaurants', labelEn: 'My restaurants',
    href: '/pro/restaurants',
    match: p => p === '/pro' || p.startsWith('/pro/restaurants'),
  },
  {
    key: 'myEvents', icon: '🎉',
    labelFr: 'Mes événements', labelEn: 'My events',
    href: '/pro/events',
    match: p => p.startsWith('/pro/events'),
  },
  {
    key: 'account', icon: '👤',
    labelFr: 'Compte', labelEn: 'Account',
    href: '/account',
    match: p => p === '/account' || p === '/pro/profile',
  },
] as const

export const NAV: Record<NavMode, readonly NavDestination[]> = {
  client: CLIENT_NAV,
  pro:    PRO_NAV,
}

/** The destinations a viewer in `mode` should see, in render order. Pass the
 *  mode already resolved (ModeContext's `effectiveMode`), the viewer's
 *  highest team role and whether they are on a restaurant team. */
export function navFor(mode: NavMode, topRole: TeamRole | null, hasRestaurant = false): NavDestination[] {
  return NAV[mode].filter(d =>
    meetsRole(topRole, d.minRole)
    && (d.requiresRestaurant === undefined || d.requiresRestaurant === hasRestaurant))
}

/** Locale-picked label, so callers don't repeat the ternary. */
export function navLabel(d: NavDestination, locale: string): string {
  return locale === 'en' ? d.labelEn : d.labelFr
}

// ── Restaurant tools ────────────────────────────────────────────────────────
// The tools inside one restaurant, in display order. `minRole` is the lowest
// team role that sees the tool; a platform admin counts as owner. Dashboard
// tools switch the dashboard tab (through ModeContext, like the nav); Team
// lives on /account.
export type RestaurantToolKey = DashboardTab | 'team'
export interface RestaurantTool {
  key:      RestaurantToolKey
  icon:     string
  labelFr:  string
  labelEn:  string
  minRole?: TeamRole
  /** Set for tools outside the dashboard. */
  href?:    string
}

export const RESTAURANT_TOOLS: readonly RestaurantTool[] = [
  { key: 'orders',   icon: '📦', labelFr: 'Commandes',  labelEn: 'Orders' },
  { key: 'menu',     icon: '🍽️', labelFr: 'Menu',       labelEn: 'Menu',     minRole: 'manager' },
  { key: 'vouchers', icon: '🎫', labelFr: 'Bons',       labelEn: 'Vouchers', minRole: 'manager' },
  { key: 'validate', icon: '✅', labelFr: 'Valider',    labelEn: 'Validate' },
  // Owners get the full settings panel, managers a reduced one.
  { key: 'settings', icon: '⚙️', labelFr: 'Paramètres', labelEn: 'Settings', minRole: 'manager' },
  { key: 'team',     icon: '👥', labelFr: 'Équipe',     labelEn: 'Team',     minRole: 'owner', href: '/account?tab=team' },
] as const

/** The tools a viewer holding `role` in a restaurant sees. */
export function restaurantToolsFor(role: TeamRole | 'admin' | null | undefined): RestaurantTool[] {
  const r: TeamRole | null = role === 'admin' ? 'owner' : role ?? null
  return RESTAURANT_TOOLS.filter(t => meetsRole(r, t.minRole))
}

export function toolLabel(t: RestaurantTool, locale: string): string {
  return locale === 'en' ? t.labelEn : t.labelFr
}
