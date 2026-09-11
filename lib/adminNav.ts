// Single source of truth for the ADMIN navigation set.
//
// Hoisted out of app/account/page.tsx, where all of this lived at module
// scope and unexported. That was fine while the admin nav was an in-page
// tile/tab grid rendered by the same component that owned the rules. It
// stopped being fine when the nav moved into TopNav: a second component
// needs the same labels, the same ordering and — critically — the same
// permission rules, and the only way to get them from a page module is to
// copy them. This project has already been bitten by duplicated constants
// twice, so the constants moved rather than the copy.
//
// SHAPE: data + pure functions, no React, no JSX, no runtime imports —
// deliberately the same contract as lib/navConfig.ts, so this module can be
// imported from a client component, a server component or an Edge runtime
// without dragging anything behind it.
//
// The CANONICAL consumers are app/account/page.tsx (which renders the
// panels) and components/TopNav.tsx (which renders the bar). Neither may
// keep a local copy of anything in here.

export type AdminSubTab =
  | 'restaurants' | 'orders' | 'events' | 'broadcasts' | 'promotions'
  | 'vouchers' | 'reports' | 'accounts' | 'messages' | 'platformteam' | 'profile'

// The roles that get the admin console instead of the customer app.
//
// This list is currently ALSO spelled out inline in components/BottomNav.tsx
// and middleware.ts. Those two are left alone here rather than converged in
// a commit about the top bar — but they are the remaining copies, and this
// is the one they should collapse into.
export const ADMIN_ROLES: readonly string[] = ['super_admin', 'admin', 'moderator']

export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && ADMIN_ROLES.includes(role)
}

// Explicit bilingual labels — avoids the earlier bug where the label was
// built from the tab value (e.g. `account.adminNav${capitalize(sub)}`),
// which produced a non-existent key `account.adminNavPlatformteam` and
// rendered raw in the UI.
export const ADMIN_TAB_LABELS: Record<AdminSubTab, string> = {
  restaurants:  'Restaurants',
  orders:       'Commandes / Orders',
  events:       'Événements / Events',
  broadcasts:   'Diffusions / Broadcasts',
  promotions:   'Promotions / Promotions',
  vouchers:     'Bons / Vouchers',
  reports:      'Signalements / Reports',
  accounts:     'Comptes / Accounts',
  messages:     'Messages / Messages',
  platformteam: 'Équipe plateforme / Platform Team',
  profile:      'Mon profil / My Profile',
}

// Icons live beside the labels rather than inside them: the same tab renders
// as a tile, a menu row, a top-bar link and a dropdown item, so the glyph has
// to be addressable on its own.
export const ADMIN_TAB_ICONS: Record<AdminSubTab, string> = {
  restaurants:  '🏪',
  orders:       '📦',
  events:       '🎉',
  broadcasts:   '📢',
  promotions:   '📣',
  vouchers:     '🎫',
  reports:      '🚩',
  accounts:     '👥',
  messages:     '📨',
  platformteam: '🛡',
  profile:      '👤',
}

// The split. ADMIN_TILES are the three surfaces an admin opens most; the
// rest are secondary.
//
// This division predates the top bar — it was "quick-access tiles" vs "menu
// rows" in the in-page grid — and it maps onto the bar with nothing to
// change: TILES are the primary links, ROWS are the ⋯ menu, in this order.
// Keep the two arrays as the ordering authority for BOTH surfaces so the bar
// and the (still-live) mobile grid can never present the items differently.
export const ADMIN_TILES: readonly AdminSubTab[] = ['accounts', 'restaurants', 'events']
export const ADMIN_ROWS:  readonly AdminSubTab[] = [
  'orders', 'reports', 'broadcasts', 'promotions', 'vouchers', 'messages', 'platformteam', 'profile',
]
export const ADMIN_TABS:  readonly AdminSubTab[] = [...ADMIN_TILES, ...ADMIN_ROWS]

export function isAdminTab(v: string): v is AdminSubTab {
  return (ADMIN_TABS as readonly string[]).includes(v)
}

// Which admin surfaces a role may reach. Pure, so it can run before any
// component state exists — the ?tab= adoption needs it inside an
// /api/auth/me handler, and TopNav needs it before its own session fetch
// has anywhere to put the answer.
//
// PRESENTATION ONLY. Hiding a tab hides an entry point, not a capability:
// every admin API route does its own authorization, and must keep doing it.
export function adminCanFor(role: string | null | undefined, tab: AdminSubTab): boolean {
  if (!role) return false
  // Everyone in the admin dashboard can see their own profile
  if (tab === 'profile') return true
  if (role === 'super_admin') return true
  if (role === 'admin') return tab !== 'platformteam'
  // Message bodies include verification codes, so the log stays with
  // admin / super_admin — moderators don't get it.
  if (role === 'moderator') return ['restaurants', 'orders', 'events', 'broadcasts', 'promotions', 'reports'].includes(tab)
  return false
}

/** The tabs `role` may open, in render order. The bar and the ⋯ menu each
 *  call this on their own half, so there is one filter, applied twice —
 *  never two rule sets that can disagree. */
export function visibleAdminTabs(
  role: string | null | undefined,
  from: readonly AdminSubTab[] = ADMIN_TABS,
): AdminSubTab[] {
  return from.filter(tab => adminCanFor(role, tab))
}

// Landing tab when no (or no permitted) ?tab= is present. Derived from the
// visible list rather than hardcoded, so a role that can't see the first
// tile doesn't land on a blank panel.
export function firstVisibleAdminTab(role: string | null | undefined): AdminSubTab {
  return ADMIN_TABS.find(tab => adminCanFor(role, tab)) ?? 'profile'
}

// NO label helper here on purpose. lib/languageContext.tsx already exports
// pickBi(), which splits the same "fr / en" form and handles an EN half that
// itself contains " / ". Re-implementing it locally would be the exact
// duplication this module exists to stop — callers do
// pickBi(ADMIN_TAB_LABELS[tab], locale), and languageContext stays out of
// here because it is a React module and this one is deliberately not.
