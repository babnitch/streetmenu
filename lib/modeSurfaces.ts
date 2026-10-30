// Client and Pro modes, kept apart. Pure and client-safe: the account page,
// the ☰ menu, the page gates and the badges all read these rules, and the
// tests check them for every entry point in both modes.
//
// Rule: each mode shows ONLY its own menus and alerts, and the mode changes
// ONLY through the switch (ModeToggle) or an explicit "Passer en mode Pro /
// Client" button (ModeGate) — never silently because a page was opened.
// WhatsApp messages are not affected: they always go to the phone.

export type AppMode = 'client' | 'pro'
export type PageMode = AppMode | 'any'

// Pages that belong to Pro mode (opened in Client mode → the switch screen).
const PRO_PREFIXES = ['/pro', '/dashboard', '/scanner', '/livraisons', '/events/submit']
// /account sections that belong to Client mode (deep links from WhatsApp).
export const CLIENT_ACCOUNT_TABS = ['orders', 'bookings', 'vouchers', 'favorites'] as const

export function pageMode(pathname: string, search = ''): PageMode {
  const p = pathname.replace(/\/+$/, '') || '/'
  if (PRO_PREFIXES.some(x => p === x || p.startsWith(`${x}/`))) return 'pro'
  if (p === '/account') {
    const tab = new URLSearchParams(search.startsWith('?') ? search : `?${search}`).get('tab')
    if (tab && (CLIENT_ACCOUNT_TABS as readonly string[]).includes(tab)) return 'client'
  }
  return 'any'
}

export interface ModeFlags {
  hasRestaurant: boolean        // on a restaurant team
  isOwner: boolean              // owner of the active restaurant
  checksEvents: boolean         // door staff or organiser of an event to check
  isRider: boolean
  canPromote: boolean
  canBroadcast: boolean
}

export type AccountItem =
  // Client
  | 'orders' | 'bookings' | 'vouchers' | 'favorites' | 'profile' | 'notifications'
  // Pro
  | 'restaurantTools' | 'myRestaurant' | 'team' | 'myEvents' | 'createEvent' | 'doorCheck'
  | 'deliveries' | 'proProfile' | 'modules' | 'promote' | 'broadcast' | 'addRestaurant'
  // Both
  | 'language' | 'lowData' | 'modeSwitch' | 'signOut'

const COMMON: AccountItem[] = ['language', 'lowData', 'modeSwitch', 'signOut']

// The account page (mobile list and desktop), in display order.
export function accountItems(mode: AppMode, f: ModeFlags): AccountItem[] {
  if (mode === 'client') {
    return ['orders', 'bookings', 'vouchers', 'favorites', 'profile', 'notifications', ...COMMON]
  }
  const items: AccountItem[] = []
  if (f.hasRestaurant) items.push('restaurantTools', 'myRestaurant')
  if (f.hasRestaurant && f.isOwner) items.push('team')
  items.push('myEvents', 'createEvent')
  if (f.checksEvents) items.push('doorCheck')
  if (f.isRider) items.push('deliveries')
  items.push('proProfile', 'modules')
  if (f.canPromote) items.push('promote')
  if (f.canBroadcast) items.push('broadcast')
  items.push('addRestaurant', ...COMMON)
  return items
}

export type SideItem =
  | 'signup' | 'login' | 'account'
  // Client
  | 'myOrders' | 'myBookings' | 'myFavorites' | 'proSpace'
  // Pro
  | 'restaurantOrders' | 'myEvents' | 'doorCheck' | 'deliveries' | 'addRestaurant' | 'addEventOrPlace' | 'proHelp'
  // Both
  | 'lowData' | 'language' | 'signOut'

// The ☰ menu, in display order. Logged out it is a client menu with the
// way in to Pro ("Espace Pro" → login, then the switch screen).
export function sideMenuItems(mode: AppMode, loggedIn: boolean, f: ModeFlags): SideItem[] {
  if (!loggedIn) return ['signup', 'login', 'proSpace', 'lowData', 'language']
  if (mode === 'client') return ['account', 'myOrders', 'myBookings', 'myFavorites', 'proSpace', 'lowData', 'language', 'signOut']
  const items: SideItem[] = ['account']
  if (f.hasRestaurant) items.push('restaurantOrders')
  items.push('myEvents')
  if (f.checksEvents) items.push('doorCheck')
  if (f.isRider) items.push('deliveries')
  items.push('addRestaurant', 'addEventOrPlace', 'proHelp', 'lowData', 'language', 'signOut')
  return items
}

// In-app badges and alerts follow the mode: pro alerts (pending restaurant
// orders, organiser / door / rider alerts) only in Pro mode; customer
// badges (cart count, welcome voucher) only in Client mode.
export function showProAlerts(mode: AppMode): boolean { return mode === 'pro' }
export function showCustomerBadges(mode: AppMode): boolean { return mode === 'client' }
