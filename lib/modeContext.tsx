'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react'
import { runClientVersionGuard } from './clientVersion'
import {
  isAdminRole, isAdminTab, adminCanFor, firstVisibleAdminTab, type AdminSubTab,
} from './adminNav'

// ModeContext tracks whether a user with a restaurant_team role is currently
// browsing as a customer ("client") or managing their restaurant ("restaurant").
//
// `hasRestaurantRole` is the gate for rendering the mode switcher at all — a
// pure customer (no team membership) never sees it, and an admin session also
// keeps it hidden (admins navigate via /account admin tabs, not the switcher).

export type Mode     = 'client' | 'restaurant'
export type TeamRole = 'owner' | 'manager' | 'staff'
export type DashboardTab = 'orders' | 'menu' | 'validate' | 'vouchers' | 'team' | 'settings'

interface ModeContextValue {
  mode: Mode
  setMode: (m: Mode) => void
  /** Clears the persisted mode back to 'client' and re-runs the vendor
   *  probe. Called on sign-out so a logged-out visitor can't retain
   *  restaurant mode or a stale hasRestaurantRole. */
  resetMode: () => void
  /** THE canonical resolved mode — "restaurant" only when the session
   *  actually holds a team role. Consumers should read this instead of
   *  re-deriving `hasRestaurantRole && mode === 'restaurant'`, which is
   *  currently duplicated in BottomNav, TopNav, the account page and
   *  ModeToggle. Those four are rewired in a follow-up. */
  effectiveMode: Mode
  hasRestaurantRole: boolean
  /** Highest role held across any of the user's restaurants (owner beats
   *  manager beats staff). `null` when the user isn't on any team. The
   *  nav variants and role-gated links read this — per-restaurant
   *  authorisation still happens server-side. */
  topRole: TeamRole | null
  /** `true` while the initial auth/team probe is in flight. UI should avoid
   *  flashing the switcher or nav variant during this window. */
  loading: boolean
  /** Currently-selected tab on /dashboard. Lives here (not in the page)
   *  so BottomNav/TopNav can flip it without a route change — tapping
   *  a tab was unreliable when we encoded it in ?tab=… because Next.js
   *  treats /dashboard?tab=a and /dashboard?tab=b as the same route
   *  and skips re-render. */
  dashboardTab: DashboardTab
  setDashboardTab: (t: DashboardTab) => void
  /** The session's role, as reported by /api/auth/me. Exposed so consumers
   *  can gate on it without repeating the fetch this provider already
   *  makes. `null` when logged out. */
  sessionRole: string | null
  /** Currently-selected panel in the admin console. Here for the SAME
   *  reason as dashboardTab above: the admin nav moved into TopNav, which
   *  cannot reach /account's local state, and linking to /account?tab=x
   *  does not work because Next treats ?tab=a and ?tab=b as one route and
   *  skips the re-render.
   *
   *  This provider — not the account page — owns the ?tab= history entry
   *  and the popstate listener that reads it back, so the URL stays the
   *  single source of truth for deep links and Back no matter which
   *  surface made the selection. */
  adminTab: AdminSubTab
  /** Select an admin panel AND push ?tab= onto the history stack. */
  setAdminTab: (t: AdminSubTab) => void
}

const STORAGE_KEY = 'tn_mode'
// Client is the safe default: it's the only mode a visitor with no team
// role can be in, and it means a vendor who has never touched the switcher
// is never dropped into restaurant mode without choosing it. (It used to
// default to 'restaurant' on the theory that vendors care about orders
// first — but that also caught every customer who later joined a team, and
// every user whose stored mode a CLIENT_VERSION bump had cleared.)
const DEFAULT_MODE: Mode = 'client'

// Permission tiers inside restaurant mode. `as const` so the literal values
// are part of the type — lib/navConfig.ts keeps its own copy (to stay free
// of runtime imports) and asserts structural equality against RoleRankShape,
// so the two ladders cannot drift without failing typecheck.
export const ROLE_RANK = { staff: 1, manager: 2, owner: 3 } as const
export type RoleRankShape = typeof ROLE_RANK
function pickTopRole(roles: TeamRole[]): TeamRole | null {
  if (!roles.length) return null
  return roles.reduce<TeamRole>((best, r) => ROLE_RANK[r] > ROLE_RANK[best] ? r : best, roles[0])
}

const ModeContext = createContext<ModeContextValue>({
  mode: DEFAULT_MODE,
  setMode: () => {},
  resetMode: () => {},
  effectiveMode: 'client',
  hasRestaurantRole: false,
  topRole: null,
  loading: true,
  dashboardTab: 'orders',
  setDashboardTab: () => {},
  sessionRole: null,
  adminTab: 'accounts',
  setAdminTab: () => {},
})

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState]                 = useState<Mode>(DEFAULT_MODE)
  const [hasRestaurantRole, setHasRestaurant] = useState(false)
  const [topRole, setTopRole]                 = useState<TeamRole | null>(null)
  const [loading, setLoading]                 = useState(true)
  const [dashboardTab, setDashboardTab]      = useState<DashboardTab>('orders')
  const [sessionRole, setSessionRole]        = useState<string | null>(null)
  const [adminTab, setAdminTabState]         = useState<AdminSubTab>('accounts')

  // Restore the persisted mode choice on mount. Only the two known values
  // are accepted — guards against stale storage from a prior schema. The
  // version guard runs first so we never read a value written by an
  // incompatible older release.
  useEffect(() => {
    runClientVersionGuard()
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'client' || stored === 'restaurant') setModeState(stored)
    } catch {}
  }, [])

  // Unmount guard. Lives in a ref (rather than a per-effect closure) because
  // `probe` is now callable from outside the effect — resetMode() re-runs it
  // on sign-out — so the two need to share one cancellation flag.
  const cancelledRef = useRef(false)

  // ── Admin ?tab= ownership ────────────────────────────────────────────────
  // Everything that reads or writes the ?tab= query param for the admin
  // console lives in these three functions. It used to live in
  // app/account/page.tsx, which was fine while that page also rendered the
  // nav; now TopNav renders the nav and the page renders the panels, so
  // neither can own it and the provider between them does.
  //
  // pushState directly, NOT router.push: Next treats /account?tab=a and
  // /account?tab=b as the same route and skips the re-render, which is the
  // whole reason the selection is context state rather than URL state.
  const pushAdminTab = useCallback((tab: AdminSubTab) => {
    if (typeof window === 'undefined') return
    // Only /account carries ?tab=. Selecting an admin item from anywhere
    // else is a REAL route change, and the router owns the URL there —
    // pushing here as well would first stamp ?tab= onto the page being left
    // (/events?tab=accounts) and leave a junk entry in the history stack.
    if (window.location.pathname !== '/account') return
    const url = new URL(window.location.href)
    if (url.searchParams.get('tab') === tab) return
    url.searchParams.set('tab', tab)
    window.history.pushState({}, '', url)
  }, [])

  const setAdminTab = useCallback((tab: AdminSubTab) => {
    setAdminTabState(tab)
    pushAdminTab(tab)
  }, [pushAdminTab])

  // Mount-time adoption of a deep link. A hand-edited or bookmarked ?tab= is
  // untrusted input, so it is re-validated against adminCanFor rather than
  // trusted — an unreadable tab falls back to the role's first visible one
  // instead of rendering a blank panel.
  const seedAdminTabFromUrl = useCallback((role: string) => {
    if (typeof window === 'undefined') return
    const q = new URLSearchParams(window.location.search).get('tab')
    if (q && isAdminTab(q) && adminCanFor(role, q)) {
      setAdminTabState(q)
      // Someone arriving on a bookmarked ?tab= has no tab-less entry behind
      // them, so Back would leave the site. Seed one: rewrite this entry as
      // the tab-less root, then push the deep link on top of it. Back now
      // always lands on the console root. Done HERE and nowhere else — two
      // copies of this would seed two entries and take two Backs to escape.
      const deep = new URL(window.location.href)
      const root = new URL(window.location.href)
      root.searchParams.delete('tab')
      window.history.replaceState({}, '', root)
      window.history.pushState({}, '', deep)
    } else {
      setAdminTabState(firstVisibleAdminTab(role))
    }
  }, [])

  // Back / Forward between admin tabs. Every selection pushed an entry, so
  // popstate just re-reads the URL and re-applies it — re-validating for the
  // same reason the seed does. No entry, or one this role may not open,
  // returns to the role's first visible tab.
  useEffect(() => {
    if (!isAdminRole(sessionRole)) return
    const onPop = () => {
      const q = new URLSearchParams(window.location.search).get('tab')
      setAdminTabState(
        q && isAdminTab(q) && adminCanFor(sessionRole, q)
          ? q
          : firstVisibleAdminTab(sessionRole),
      )
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [sessionRole])

  // Probe the session + vendor status. Admins and pure customers end up with
  // hasRestaurantRole=false; any active team membership (owner, manager, or
  // staff) flips it on. Runs on mount, whenever the tab regains focus (so a
  // freshly-accepted WhatsApp invitation shows up without a manual reload),
  // and on sign-out via resetMode().
  const probe = useCallback(async () => {
    try {
      const meRes = await fetch('/api/auth/me', { cache: 'no-store' })
      const me = await meRes.json()
      if (cancelledRef.current) return
      if (!me?.user) {
        setHasRestaurant(false); setTopRole(null); setSessionRole(null)
        return
      }
      setSessionRole(me.user.role)
      if (isAdminRole(me.user.role)) {
        setHasRestaurant(false); setTopRole(null)
        seedAdminTabFromUrl(me.user.role)
        return
      }
      const vRes = await fetch('/api/vendor/restaurants', { cache: 'no-store' })
      const v = await vRes.json()
      if (cancelledRef.current) return
      const list: Array<{ teamRole?: TeamRole }> = v.restaurants ?? []
      const roles = list.map(r => r.teamRole).filter(Boolean) as TeamRole[]
      setHasRestaurant(list.length > 0)
      setTopRole(pickTopRole(roles))
    } catch {
      if (!cancelledRef.current) { setHasRestaurant(false); setTopRole(null); setSessionRole(null) }
    } finally {
      if (!cancelledRef.current) setLoading(false)
    }
  }, [seedAdminTabFromUrl])

  useEffect(() => {
    cancelledRef.current = false
    probe()
    const onFocus = () => { probe() }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelledRef.current = true
      window.removeEventListener('focus', onFocus)
    }
  }, [probe])

  const setMode = useCallback((m: Mode) => {
    setModeState(m)
    try { localStorage.setItem(STORAGE_KEY, m) } catch {}
  }, [])

  // Sign-out path: drop the stored preference entirely (so the next visitor
  // on this device gets DEFAULT_MODE rather than the previous user's choice)
  // and re-probe, which with the session cookie gone resolves to
  // hasRestaurantRole=false / topRole=null.
  const resetMode = useCallback(() => {
    setModeState('client')
    try { localStorage.removeItem(STORAGE_KEY) } catch {}
    setLoading(true)
    void probe()
  }, [probe])

  // The one place this is derived. See the note on ModeContextValue.
  const effectiveMode: Mode =
    hasRestaurantRole && mode === 'restaurant' ? 'restaurant' : 'client'

  return (
    <ModeContext.Provider
      value={{
        mode, setMode, resetMode, effectiveMode,
        hasRestaurantRole, topRole, loading,
        dashboardTab, setDashboardTab,
        sessionRole, adminTab, setAdminTab,
      }}
    >
      {children}
    </ModeContext.Provider>
  )
}

export function useMode() {
  return useContext(ModeContext)
}
