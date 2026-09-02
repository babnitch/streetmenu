'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react'
import { runClientVersionGuard } from './clientVersion'

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
})

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState]                 = useState<Mode>(DEFAULT_MODE)
  const [hasRestaurantRole, setHasRestaurant] = useState(false)
  const [topRole, setTopRole]                 = useState<TeamRole | null>(null)
  const [loading, setLoading]                 = useState(true)
  const [dashboardTab, setDashboardTab]      = useState<DashboardTab>('orders')

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
        setHasRestaurant(false); setTopRole(null)
        return
      }
      if (['super_admin', 'admin', 'moderator'].includes(me.user.role)) {
        setHasRestaurant(false); setTopRole(null)
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
      if (!cancelledRef.current) { setHasRestaurant(false); setTopRole(null) }
    } finally {
      if (!cancelledRef.current) setLoading(false)
    }
  }, [])

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
      }}
    >
      {children}
    </ModeContext.Provider>
  )
}

export function useMode() {
  return useContext(ModeContext)
}
