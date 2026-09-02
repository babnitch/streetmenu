'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useLanguage } from '@/lib/languageContext'
import { useCart } from '@/lib/cartContext'
import { useMode } from '@/lib/modeContext'
import { navFor, navLabel, type NavDestination } from '@/lib/navConfig'
import SearchOverlay from './SearchOverlay'

// Mobile-only fixed bottom tab bar. The tab set is NOT defined here — it
// comes from lib/navConfig.ts, the single source both this bar and the
// desktop TopNav render from, so the two can no longer drift:
//
//   client      🏠 Restaurants · 🎉 Événements · 🔍 Recherche · 🛒 Panier · 👤 Compte
//   restaurant  📦 Commandes   · 🍽️ Menu       · 🔍 Recherche · 👤 Compte
//
// Menu carries minRole 'manager', so staff no longer see it here — the
// desktop nav and the dashboard's own strip already gated it that way.
//
// Dashboard tabs are switched through ModeContext, never a ?tab= query:
// Next.js treats /dashboard?tab=a and /dashboard?tab=b as the same route
// and skips the re-render, which used to swallow taps.
//
// Hidden at md+ (≥768px); the TopNav takes over there.

export default function BottomNav() {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const { locale } = useLanguage()
  const { totalItems } = useCart()
  const {
    effectiveMode, hasRestaurantRole, topRole,
    dashboardTab, setDashboardTab, loading: modeLoading,
  } = useMode()

  const [isAdmin, setIsAdmin] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  // Gates the first render so the bar doesn't flash in on an admin
  // session before we know to hide it.
  const [authProbed, setAuthProbed] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const meRes = await fetch('/api/auth/me', { cache: 'no-store' })
        const me = await meRes.json()
        if (cancelled) return
        if (me?.user && ['super_admin', 'admin', 'moderator'].includes(me.user.role)) {
          setIsAdmin(true)
        }
      } catch { /* swallow — show the standard bar */ }
      finally { if (!cancelled) setAuthProbed(true) }
    })()
    return () => { cancelled = true }
  }, [])

  // Close the overlay on any route change so a result tap doesn't leave
  // it hanging over the destination page.
  useEffect(() => { setSearchOpen(false) }, [pathname])

  // Vendor pending-order count for the restaurant-mode Orders badge.
  // Only polled when the session actually holds a team role, so pure
  // customers never hit the endpoint. Mirrors the TopNav cadence.
  useEffect(() => {
    if (!hasRestaurantRole) { setPendingCount(0); return }
    let cancelled = false
    const refresh = async () => {
      try {
        const r = await fetch('/api/vendor/pending-count', { cache: 'no-store' })
        const d = await r.json()
        if (!cancelled) setPendingCount(Number(d?.count ?? 0))
      } catch { /* transient network; keep prior count */ }
    }
    refresh()
    const t = setInterval(refresh, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [hasRestaurantRole])

  // Hide on /admin (admins navigate via /account admin tabs, the BottomNav
  // isn't useful there). /dashboard keeps the bar so vendors can hop back
  // out to the other tabs without losing their place.
  if (pathname.startsWith('/admin') || isAdmin) return null
  // Wait for the mode probe too, so a vendor's bar appears once with the
  // right tab set instead of flashing through the client variant.
  if (!authProbed || modeLoading) return null

  const tabs = navFor(effectiveMode, topRole)

  // Flip the dashboard tab through context and route there if needed.
  // Navigating while already on /dashboard would be a same-route no-op.
  const goToDashTab = (next: NonNullable<NavDestination['dashboardTab']>) => {
    setDashboardTab(next)
    if (!pathname.startsWith('/dashboard')) router.push('/dashboard')
  }

  const badgeFor = (d: NavDestination): number =>
    d.badgeKey === 'pendingOrders' ? pendingCount
      : d.badgeKey === 'cartCount' ? totalItems
        : 0

  return (
    <>
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />

      <nav
        role="navigation"
        aria-label="Bottom navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-divider"
      >
        {/* Column count follows the destination list — client has 5,
            restaurant 4 (and 3 for staff, who don't get Menu). */}
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
        >
          {tabs.map(d => {
            const label = navLabel(d, locale)
            // Destinations with an actionKey have renderer-owned active
            // state — the overlay's open flag isn't route state, so
            // navConfig's pure `match` can't see it.
            const active = d.actionKey === 'openSearch'
              ? searchOpen
              : d.match(pathname, dashboardTab)

            // Active tab: brand orange for both icon (full-opacity) and label.
            // Inactive: grayscale icon + tertiary label. The label layer sits
            // below the icon at 10px so it never wraps.
            const iconCls  = active ? 'opacity-100 scale-105'     : 'opacity-60 grayscale'
            const labelCls = active ? 'text-brand font-semibold'  : 'text-ink-tertiary'
            const sharedClass = 'flex flex-col items-center justify-center min-h-[60px] min-w-[44px] px-1 pt-1.5 pb-1 gap-0.5'

            const badge = badgeFor(d)
            const hasBadge = badge > 0
            // Badge floats over the icon's top-right corner (not the tab's),
            // so it hugs the emoji instead of sitting in whitespace. 16px
            // for single digit, 20px for two digits — sizing up prevents
            // a cramped "10" / "99+" clip.
            const badgeSize = badge > 9
              ? 'h-5 min-w-5 text-[10px] px-1'
              : 'h-4 w-4     text-[10px]'

            const body = (
              <>
                <span
                  aria-hidden="true"
                  className={`relative inline-block text-2xl leading-none transition-transform ${iconCls}`}
                >
                  {d.icon}
                  {hasBadge && (
                    <span
                      aria-label={`${badge} ${label}`}
                      className={`absolute -top-1 -right-1 ${badgeSize} rounded-full bg-brand text-white font-bold flex items-center justify-center leading-none ring-2 ring-surface`}
                    >
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className={`text-[10px] leading-none tracking-tight transition-colors ${labelCls}`}
                >
                  {label}
                </span>
              </>
            )

            // Search opens an overlay and dashboard tabs flip context state,
            // so both are buttons. Plain routes stay Links for prefetching.
            if (d.actionKey === 'openSearch') {
              return (
                <button key={d.key} onClick={() => setSearchOpen(true)} className={sharedClass} aria-label={label} title={label}>
                  {body}
                </button>
              )
            }
            if (d.dashboardTab) {
              const tab = d.dashboardTab
              return (
                <button key={d.key} onClick={() => goToDashTab(tab)} className={sharedClass} aria-label={label} title={label}>
                  {body}
                </button>
              )
            }
            return (
              <Link key={d.key} href={d.href ?? '/'} className={sharedClass} aria-label={label} title={label}>
                {body}
              </Link>
            )
          })}
        </div>
      </nav>
    </>
  )
}
