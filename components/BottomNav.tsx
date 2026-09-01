'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { useCart } from '@/lib/cartContext'
import { useMode, type DashboardTab } from '@/lib/modeContext'
import SearchOverlay from './SearchOverlay'

// Mobile-only fixed bottom tab bar. Two tab sets, chosen by the active
// mode (a vendor flips between them from /account):
//
//   Client      🏠 Restaurants · 🎉 Événements     · 🔍 Recherche · 🛒 Panier · 👤 Compte
//   Restaurant  📦 Commandes   · 🍽️ Menu           · 🎉 Mes événements · 🔍 Recherche · 👤 Compte
//
// Restaurant mode drops the cart (a vendor manages orders here, they
// don't place them) and repoints the first two tabs at the dashboard.
// Its Events tab opens the organizer's own event dashboard rather than
// the public browse page. Vouchers, team and restaurant settings stay
// off the bar — they live on /dashboard's own tab strip and /account.
//
// Dashboard tabs are switched through ModeContext, never a ?tab= query:
// Next.js treats /dashboard?tab=a and /dashboard?tab=b as the same route
// and skips the re-render, which used to swallow taps.
//
// Hidden at md+ (≥768px); the TopNav takes over there.

interface TabSpec {
  href:   string
  icon:   string
  label:  string
  match:  (path: string) => boolean
  onClick?: () => void      // Search opens an overlay instead of navigating
  badge?: number            // orange pill on the icon's top-right when > 0
}

export default function BottomNav() {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const bi = useBi()
  const { totalItems } = useCart()
  const {
    mode, hasRestaurantRole, dashboardTab, setDashboardTab, loading: modeLoading,
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
  // out to Home / Events / Account without losing their place.
  if (pathname.startsWith('/admin') || isAdmin) return null
  // Wait for the mode probe too, so a vendor's bar appears once with the
  // right tab set instead of flashing through the client variant.
  if (!authProbed || modeLoading) return null

  // Only honour "restaurant" for sessions that actually hold a team role —
  // guards against a stale localStorage flag showing vendor tabs to a
  // logged-out visitor.
  const effectiveMode: 'client' | 'restaurant' =
    hasRestaurantRole && mode === 'restaurant' ? 'restaurant' : 'client'

  // True when /account is showing the organizer's events — that's how the
  // restaurant-mode Events tab highlights. Read off the URL because the
  // account page owns that state.
  const onAccountEvents =
    typeof window !== 'undefined' && window.location.search.includes('tab=events')

  // Flip the dashboard tab through context and route there if needed.
  // Navigating while already on /dashboard would be a same-route no-op.
  const goToDashTab = (next: DashboardTab) => {
    setDashboardTab(next)
    if (!pathname.startsWith('/dashboard')) router.push('/dashboard')
  }

  // The organizer's event dashboard is the account page's events section.
  // Push the URL so a cold load lands there, and fire the event the
  // account page listens for so an in-place switch works too — its ?tab=
  // reader runs on mount only.
  const goToMyEvents = () => {
    router.push('/account?tab=events')
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nt-account-tab', { detail: 'events' }))
    }
  }

  const searchTab: TabSpec = {
    href: '#search', icon: '🔍', label: bi('Recherche', 'Search'),
    match: () => searchOpen,
    onClick: () => setSearchOpen(true),
  }

  const clientTabs: TabSpec[] = [
    // Same label in both locales — "Restaurants" reads the same in FR and
    // EN, so it goes through bi() unchanged rather than being special-cased.
    { href: '/',        icon: '🏠', label: bi('Restaurants', 'Restaurants'),
      match: p => p === '/' || p.startsWith('/restaurant') },
    { href: '/events',  icon: '🎉', label: bi('Événements', 'Events'),
      match: p => p.startsWith('/events') },
    searchTab,
    { href: '/order',   icon: '🛒', label: bi('Panier', 'Cart'),
      match: p => p === '/order',
      badge: totalItems },
    { href: '/account', icon: '👤', label: bi('Compte', 'Account'),
      match: p => p === '/account' },
  ]

  const restaurantTabs: TabSpec[] = [
    { href: '/dashboard', icon: '📦', label: bi('Commandes', 'Orders'),
      match: p => p.startsWith('/dashboard') && dashboardTab !== 'menu',
      onClick: () => goToDashTab('orders'),
      badge: pendingCount },
    { href: '/dashboard', icon: '🍽️', label: bi('Menu', 'Menu'),
      match: p => p.startsWith('/dashboard') && dashboardTab === 'menu',
      onClick: () => goToDashTab('menu') },
    { href: '/account?tab=events', icon: '🎉', label: bi('Mes événements', 'My events'),
      match: p => p === '/account' && onAccountEvents,
      onClick: goToMyEvents },
    searchTab,
    { href: '/account', icon: '👤', label: bi('Compte', 'Account'),
      match: p => p === '/account' && !onAccountEvents },
  ]

  const tabs: TabSpec[] = effectiveMode === 'restaurant' ? restaurantTabs : clientTabs

  return (
    <>
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />

      <nav
        role="navigation"
        aria-label="Bottom navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-divider"
      >
        <div className="grid grid-cols-5">
          {tabs.map((tab, i) => {
            const active = tab.match(pathname)
            // Active tab: brand orange for both icon (full-opacity) and label.
            // Inactive: grayscale icon + tertiary label. The label layer sits
            // below the icon at 10px so it never wraps.
            const iconCls  = active ? 'opacity-100 scale-105'     : 'opacity-60 grayscale'
            const labelCls = active ? 'text-brand font-semibold'  : 'text-ink-tertiary'
            const sharedClass = 'flex flex-col items-center justify-center min-h-[60px] min-w-[44px] px-1 pt-1.5 pb-1 gap-0.5'
            const hasBadge   = tab.badge != null && tab.badge > 0
            const badgeTwoDigit = hasBadge && (tab.badge as number) > 9
            // Badge floats over the icon's top-right corner (not the tab's),
            // so it hugs the emoji instead of sitting in whitespace. 16px
            // for single digit, 20px for two digits — sizing up prevents
            // a cramped "10" / "99+" clip.
            const badgeSize  = badgeTwoDigit
              ? 'h-5 min-w-5 text-[10px] px-1'
              : 'h-4 w-4     text-[10px]'

            const body = (
              <>
                <span
                  aria-hidden="true"
                  className={`relative inline-block text-2xl leading-none transition-transform ${iconCls}`}
                >
                  {tab.icon}
                  {hasBadge && (
                    <span
                      aria-label={`${tab.badge} ${tab.label}`}
                      className={`absolute -top-1 -right-1 ${badgeSize} rounded-full bg-brand text-white font-bold flex items-center justify-center leading-none ring-2 ring-surface`}
                    >
                      {(tab.badge as number) > 99 ? '99+' : tab.badge}
                    </span>
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className={`text-[10px] leading-none tracking-tight transition-colors ${labelCls}`}
                >
                  {tab.label}
                </span>
              </>
            )

            // Search is a button (it opens the overlay rather than doing a
            // route change); the rest are Links so prefetching kicks in.
            if (tab.onClick) {
              return (
                <button key={i} onClick={tab.onClick} className={sharedClass} aria-label={tab.label} title={tab.label}>
                  {body}
                </button>
              )
            }
            return (
              <Link key={i} href={tab.href} className={sharedClass} aria-label={tab.label} title={tab.label}>
                {body}
              </Link>
            )
          })}
        </div>
      </nav>
    </>
  )
}
