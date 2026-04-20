'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'

// Mobile-only fixed bottom tab bar. Two variants:
//
// - Client mode:      🏠 Home · 🔍 Search · 🎉 Events · 📦 Orders · 👤 Account
// - Restaurant mode:  📦 Orders · 🍽️ Menu (manager+) · 👥 Team (owner) · ⚙️ Settings (owner) · 👤 Account
//
// Hidden at md+ (≥768px) — the TopNav takes over there. Icon-only, no labels:
// with 5 tabs the text overlapped on 375px screens. aria-label keeps it
// accessible. Pure customers (no team role) only ever see the client variant.

interface TabSpec {
  href:   string
  icon:   string
  /** Short label displayed beneath the icon (also used for aria-label). */
  label:  string
  match:  (path: string) => boolean
  onClick?: () => void      // Search uses this instead of href-nav
  badge?: number            // red pill on icon top-right when > 0
}

export default function BottomNav() {
  const pathname = usePathname() ?? ''
  const bi = useBi()
  const { mode, hasRestaurantRole, topRole } = useMode()

  const [isAdmin, setIsAdmin] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  // Initial vendor probe + start polling pending count. Poll interval 30s
  // per spec — light enough to not burn battery, frequent enough to feel
  // near-real-time on the restaurant tab badge.
  useEffect(() => {
    let cancelled = false
    let pollTimer: ReturnType<typeof setInterval> | null = null

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
          pollTimer = setInterval(refreshCount, 30_000)
        }
      } catch { /* swallow — show base tabs */ }
    }

    probe()
    return () => {
      cancelled = true
      if (pollTimer) clearInterval(pollTimer)
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

  // Which ?tab= is currently selected on /dashboard (read at render time
  // from window.location so the active-tab highlight follows navigation).
  const dashTab = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('tab') ?? 'orders'
    : 'orders'

  const clientTabs: TabSpec[] = [
    { href: '/',          icon: '🏠', label: bi('Restaurants', 'Restaurants'), match: p => p === '/' || p.startsWith('/restaurant') },
    { href: '/events',    icon: '🎉', label: bi('Événements', 'Events'),       match: p => p.startsWith('/events') },
    ...(isLoggedIn ? [
      { href: '/account?tab=orders', icon: '📦', label: bi('Commandes', 'Orders'),
        match: (p: string) => p === '/account' && (typeof window !== 'undefined' && window.location.search.includes('tab=orders')) }
    ] : []),
    { href: '/account',   icon: '👤', label: bi('Compte', 'Account'),
      match: p => p === '/account' && !(typeof window !== 'undefined' && window.location.search.includes('tab=orders')) },
  ]

  const isOwner   = topRole === 'owner'
  const isManager = topRole === 'manager'

  // Short single-word labels. "Réglages" fits 10px on 375px; "Paramètres"
  // would wrap next to 4 other tabs.
  const restaurantTabs: TabSpec[] = [
    { href: '/dashboard?tab=orders',   icon: '📦', label: bi('Commandes', 'Orders'),
      match: p => p.startsWith('/dashboard') && (dashTab === 'orders' || !['menu','team','settings'].includes(dashTab)),
      badge: pendingCount },
    ...((isOwner || isManager) ? [
      { href: '/dashboard?tab=menu',   icon: '🍽️', label: bi('Menu', 'Menu'),
        match: (p: string) => p.startsWith('/dashboard') && dashTab === 'menu' }
    ] : []),
    ...(isOwner ? [
      { href: '/dashboard?tab=team',   icon: '👥', label: bi('Équipe', 'Team'),
        match: (p: string) => p.startsWith('/dashboard') && dashTab === 'team' },
      { href: '/dashboard?tab=settings', icon: '⚙️', label: bi('Réglages', 'Settings'),
        match: (p: string) => p.startsWith('/dashboard') && dashTab === 'settings' },
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
          const sharedClass = 'relative flex flex-col items-center justify-center min-h-[60px] min-w-[44px] px-1 pt-1.5 pb-1 gap-0.5'

          const body = (
            <>
              <span
                aria-hidden="true"
                className={`text-2xl leading-none transition-transform ${iconCls}`}
              >
                {tab.icon}
              </span>
              <span
                aria-hidden="true"
                className={`text-[10px] leading-none tracking-tight transition-colors ${labelCls}`}
              >
                {tab.label}
              </span>
              {tab.badge != null && tab.badge > 0 && (
                <span
                  aria-label={`${tab.badge} ${tab.label} pending`}
                  className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center leading-none"
                >
                  {tab.badge > 99 ? '99+' : tab.badge}
                </span>
              )}
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
