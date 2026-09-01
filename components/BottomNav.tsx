'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { useCart } from '@/lib/cartContext'
import SearchOverlay from './SearchOverlay'

// Mobile-only fixed bottom tab bar — one Uber Eats-style tab set for
// everyone:
//
//   🏠 Accueil · 🎉 Événements · 🔍 Recherche · 🛒 Panier · 👤 Compte
//
// Restaurant owners no longer get their own tab variant here. Their
// management surfaces (orders, menu, vouchers, team, settings) are
// reached through Account → Mon restaurant → Tableau de bord, and
// /dashboard carries its own mobile tab strip for switching between
// them. That keeps the bar identical for every user — which is what
// makes it read as a native app rather than a role-dependent menu.
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
  const bi = useBi()
  const { totalItems } = useCart()

  const [isAdmin, setIsAdmin] = useState(false)
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

  // Hide on /admin (admins navigate via /account admin tabs, the BottomNav
  // isn't useful there). /dashboard keeps the bar so vendors can hop back
  // out to Home / Events / Account without losing their place.
  if (pathname.startsWith('/admin') || isAdmin) return null
  if (!authProbed) return null

  const tabs: TabSpec[] = [
    { href: '/',        icon: '🏠', label: bi('Accueil', 'Home'),
      match: p => p === '/' || p.startsWith('/restaurant') },
    { href: '/events',  icon: '🎉', label: bi('Événements', 'Events'),
      match: p => p.startsWith('/events') },
    { href: '#search',  icon: '🔍', label: bi('Recherche', 'Search'),
      match: () => searchOpen,
      onClick: () => setSearchOpen(true) },
    { href: '/order',   icon: '🛒', label: bi('Panier', 'Cart'),
      match: p => p === '/order',
      badge: totalItems },
    { href: '/account', icon: '👤', label: bi('Compte', 'Account'),
      match: p => p === '/account' },
  ]

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
