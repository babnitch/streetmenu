'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

// ModeContext tracks whether a user with a restaurant_team role is currently
// browsing as a customer ("client") or managing their restaurant ("restaurant").
//
// `hasRestaurantRole` is the gate for rendering the mode switcher at all — a
// pure customer (no team membership) never sees it, and an admin session also
// keeps it hidden (admins navigate via /account admin tabs, not the switcher).

export type Mode     = 'client' | 'restaurant'
export type TeamRole = 'owner' | 'manager' | 'staff'
export type DashboardTab = 'orders' | 'menu' | 'validate' | 'team'

interface ModeContextValue {
  mode: Mode
  setMode: (m: Mode) => void
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

const STORAGE_KEY = 'nt_mode'
const DEFAULT_MODE: Mode = 'restaurant' // vendors care about orders first

const ROLE_RANK: Record<TeamRole, number> = { staff: 1, manager: 2, owner: 3 }
function pickTopRole(roles: TeamRole[]): TeamRole | null {
  if (!roles.length) return null
  return roles.reduce<TeamRole>((best, r) => ROLE_RANK[r] > ROLE_RANK[best] ? r : best, roles[0])
}

const ModeContext = createContext<ModeContextValue>({
  mode: DEFAULT_MODE,
  setMode: () => {},
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
  // are accepted — guards against stale storage from a prior schema.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'client' || stored === 'restaurant') setModeState(stored)
    } catch {}
  }, [])

  // Probe the session + vendor status on mount. Admins and pure customers
  // end up with hasRestaurantRole=false; any active team membership (owner,
  // manager, or staff) flips it on. We re-run the probe whenever the tab
  // regains focus so a freshly-accepted WhatsApp invitation shows up
  // without a manual reload.
  useEffect(() => {
    let cancelled = false

    async function probe() {
      try {
        const meRes = await fetch('/api/auth/me', { cache: 'no-store' })
        const me = await meRes.json()
        if (cancelled) return
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
        if (cancelled) return
        const list: Array<{ teamRole?: TeamRole }> = v.restaurants ?? []
        const roles = list.map(r => r.teamRole).filter(Boolean) as TeamRole[]
        setHasRestaurant(list.length > 0)
        setTopRole(pickTopRole(roles))
      } catch {
        if (!cancelled) { setHasRestaurant(false); setTopRole(null) }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    probe()
    const onFocus = () => probe()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const setMode = (m: Mode) => {
    setModeState(m)
    try { localStorage.setItem(STORAGE_KEY, m) } catch {}
  }

  return (
    <ModeContext.Provider value={{ mode, setMode, hasRestaurantRole, topRole, loading, dashboardTab, setDashboardTab }}>
      {children}
    </ModeContext.Provider>
  )
}

export function useMode() {
  return useContext(ModeContext)
}
