'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { useMode, type DashboardTab } from '@/lib/modeContext'

// Mobile-only fixed bottom tab bar. Two variants:
//
// - Client mode:      🏠 Home · 🎉 Events · 📦 Orders · 👤 Account
// - Restaurant mode:  📦 Orders · 🍽️ Menu (manager+) · 🎫 Vouchers · 👤 Account
//
// Team + Settings were removed from the restaurant bar — they now live
// inside the Account page so the bar stays at 4 tabs on the smallest
// phones. Hidden at md+ (≥768px) — the TopNav takes over there.

interface TabSpec {
  /** Route navigated to when the tab is tapped. For dashboard tabs this
   *  is always `/dashboard` (no query string) — the selected tab lives
   *  in ModeContext so we don't pay the Next.js same-route re-render
   *  penalty that ?tab= encoding caused. */
  href:   string
  icon:   string
  /** Short label displayed beneath the icon (also used for aria-label). */
  label:  string
  match:  (path: string) => boolean
  onClick?: () => void      // Search + dashboard tabs use this instead of href-nav
  badge?: number            // red pill on icon top-right when > 0
}

export default function BottomNav() {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const bi = useBi()
  const { mode, hasRestaurantRole, topRole, dashboardTab, setDashboardTab } = useMode()

  const [isAdmin, setIsAdmin] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)             // vendor-side
  const [customerPendingCount, setCustomerPendingCount] = useState(0) // client-side

  // Initial vendor probe + start polling pending count. Poll interval 30s
  // per spec — light enough to not burn battery, frequent enough to feel
  // near-real-time on the restaurant tab badge. Every logged-in customer
  // also gets the customer-side poll so the client-mode 📦 badge tracks
  // their own open orders.
  useEffect(() => {
    let cancelled = false
    const timers: Array<ReturnType<typeof setInterval>> = []

    async function probe() {
      try {
        const meRes = await fetch('/api/auth/me', { cache: 'no-store' })
        const me = await meRes.json()
        if (cancelled) return
        if (!me?.user) return
        setIsLoggedIn(true)
        if (['super_admin', 'admin', 'moderator'].includes(me.user.role)) {
          setIsAdmin(true)
          return
        }

        const refreshCustomerCount = async () => {
          try {
            const r = await fetch('/api/customer/pending-count', { cache: 'no-store' })
            const d = await r.json()
            if (!cancelled) setCustomerPendingCount(Number(d?.count ?? 0))
          } catch { /* transient network; keep prior count */ }
        }
        refreshCustomerCount()
        timers.push(setInterval(refreshCustomerCount, 30_000))

        const vRes = await fetch('/api/vendor/restaurants', { cache: 'no-store' })
        const v = await vRes.json()
        if (cancelled) return
        const list: Array<{ status?: string }> = v.restaurants ?? []
        const hasApproved = list.some(r => r.status && r.status !== 'pending')

        if (hasApproved) {
          const refreshCount = async () => {
            try {
              const r = await fetch('/api/vendor/pending-count', { cache: 'no-store' })
              const d = await r.json()
              if (!cancelled) setPendingCount(Number(d?.count ?? 0))
            } catch { /* transient network; keep prior count */ }
          }
          refreshCount()
          timers.push(setInterval(refreshCount, 30_000))
        }
      } catch { /* swallow — show base tabs */ }
    }

    probe()
    return () => {
      cancelled = true
      for (const t of timers) clearInterval(t)
    }
  }, [])

  // Hide on /admin (admins navigate via /account admin tabs, the BottomNav
  // isn't useful there). /dashboard keeps the bar so vendors can hop back
  // out to Home / Events / Account without losing their place.
  const hideOnRoute = pathname.startsWith('/admin') || isAdmin

  if (hideOnRoute) return null

  // Effective mode: only honor "restaurant" when the user actually has a
  // team role. Prevents a stale localStorage flag from showing vendor
  // tabs to a logged-out user.
  const effectiveMode: 'client' | 'restaurant' =
    hasRestaurantRole && mode === 'restaurant' ? 'restaurant' : 'client'

  // Dashboard tab selection comes from ModeContext — see comment at the
  // top of the file. Previously this was read from window.location
  // query and suffered from Next.js not re-rendering /dashboard when
  // only the ?tab= param changed, causing missed taps.
  const dashTab: DashboardTab = dashboardTab

  // Tapping a dashboard tab flips context state and ensures we land on
  // /dashboard. Navigating while already on /dashboard would be a
  // same-route no-op (the problem we just solved), so we skip router
  // entirely there — the context update re-renders the page.
  const goToDashTab = (next: DashboardTab) => {
    setDashboardTab(next)
    if (!pathname.startsWith('/dashboard')) router.push('/dashboard')
  }

  const clientTabs: TabSpec[] = [
    { href: '/',          icon: '🏠', label: bi('Restaurants', 'Restaurants'), match: p => p === '/' || p.startsWith('/restaurant') },
    { href: '/events',    icon: '🎉', label: bi('Événements', 'Events'),       match: p => p.startsWith('/events') },
    ...(isLoggedIn ? [
      { href: '/account?tab=orders', icon: '📦', label: bi('Commandes', 'Orders'),
        match: (p: string) => p === '/account' && (typeof window !== 'undefined' && window.location.search.includes('tab=orders')),
        badge: customerPendingCount }
    ] : []),
    { href: '/account',   icon: '👤', label: bi('Compte', 'Account'),
      match: p => p === '/account' && !(typeof window !== 'undefined' && window.location.search.includes('tab=orders')) },
  ]

  const isOwner   = topRole === 'owner'
  const isManager = topRole === 'manager'

  // 4 tabs max — Team + Settings live inside /account (Account page) so the
  // bar stays legible on 375px screens. The `validate` dashboard tab backs
  // the Vouchers entry for manager/owner; staff skip it (no voucher perms).
  const restaurantTabs: TabSpec[] = [
    { href: '/dashboard', icon: '📦', label: bi('Commandes', 'Orders'),
      match: p => p.startsWith('/dashboard') && (dashTab === 'orders' || !['menu','validate'].includes(dashTab)),
      onClick: () => goToDashTab('orders'),
      badge: pendingCount },
    ...((isOwner || isManager) ? [
      { href: '/dashboard', icon: '🍽️', label: bi('Menu', 'Menu'),
        match: (p: string) => p.startsWith('/dashboard') && dashTab === 'menu',
        onClick: () => goToDashTab('menu') }
    ] : []),
    ...((isOwner || isManager) ? [
      { href: '/dashboard', icon: '🎫', label: bi('Bons', 'Vouchers'),
        match: (p: string) => p.startsWith('/dashboard') && dashTab === 'validate',
        onClick: () => goToDashTab('validate') }
    ] : []),
    { href: '/account',                icon: '👤', label: bi('Compte', 'Account'),
      match: p => p === '/account' },
  ]

  const tabs: TabSpec[] = effectiveMode === 'restaurant' ? restaurantTabs : clientTabs

  return (
    <nav
      role="navigation"
      aria-label="Bottom navigation"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-divider"
    >
      <div
        className="grid"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
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
                    aria-label={`${tab.badge} ${tab.label} pending`}
                    className={`absolute -top-1 -right-1 ${badgeSize} rounded-full bg-danger text-white font-bold flex items-center justify-center leading-none ring-2 ring-surface`}
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

          // Search tab is a button (it focuses the home search rather than
          // doing a traditional route-change); the rest are Links so
          // prefetching still kicks in.
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
  )
}
