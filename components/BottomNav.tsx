'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

// Mobile-only fixed bottom tab bar. 5 slots:
//   Home | Search | Orders | Restaurant (vendor-gated) | Account
// Hidden at md+ (≥768px) — the TopNav takes over there.
//
// "Restaurant" slot only renders for customers with ≥1 non-pending
// approved restaurant. Admins and pending-only vendors see a 4-tab bar
// (Restaurant slot collapses). The session probe runs once on mount; no
// network on every page change.

interface TabSpec {
  href:   string
  icon:   string
  label:  string            // bilingual inline, short enough for a 4-tab row
  match:  (path: string) => boolean
  onClick?: () => void      // Search uses this instead of href-nav
}

export default function BottomNav() {
  const pathname = usePathname() ?? ''
  const router = useRouter()

  const [showVendorTab, setShowVendorTab] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const meRes = await fetch('/api/auth/me', { cache: 'no-store' })
        const me = await meRes.json()
        if (cancelled) return
        if (!me?.user) return
        if (['super_admin', 'admin', 'moderator'].includes(me.user.role)) {
          setIsAdmin(true)
          return
        }
        const vRes = await fetch('/api/vendor/restaurants', { cache: 'no-store' })
        const v = await vRes.json()
        if (cancelled) return
        const list: Array<{ status?: string }> = v.restaurants ?? []
        const hasApproved = list.some(r => r.status && r.status !== 'pending')
        setShowVendorTab(hasApproved)
      } catch { /* swallow — show base tabs */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Hide entirely on admin routes (admins navigate via the /account admin tabs).
  // Also hide on /dashboard where the page's own tabs are the primary nav.
  const hideOnRoute =
    pathname.startsWith('/admin') ||
    pathname.startsWith('/dashboard') ||
    isAdmin

  if (hideOnRoute) return null

  // Search tab routes to home with a #search anchor. The home page reads
  // the hash on mount and focuses the search input.
  const goSearch = () => router.push('/#search')

  const tabs: TabSpec[] = [
    { href: '/',                    icon: '🏠', label: 'Accueil / Home',     match: p => p === '/' || p.startsWith('/restaurant') },
    { href: '/#search',             icon: '🔍', label: 'Recherche / Search', match: () => false, onClick: goSearch },
    { href: '/account?tab=orders',  icon: '📦', label: 'Commandes / Orders', match: p => p === '/account' },
    ...(showVendorTab ? [
      { href: '/dashboard', icon: '🏪', label: 'Restaurant', match: (p: string) => p.startsWith('/dashboard') }
    ] : []),
    { href: '/account',             icon: '👤', label: 'Compte / Account',   match: p => p === '/account' },
  ]

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
          const tint = active ? 'text-brand' : 'text-ink-secondary'

          const body = (
            <>
              <span aria-hidden="true" className="text-xl leading-none">{tab.icon}</span>
              <span className={`text-[10px] font-semibold leading-tight truncate ${tint}`}>{tab.label}</span>
            </>
          )
          const sharedClass = `flex flex-col items-center justify-center gap-1 min-h-[56px] px-1 ${tint}`

          // Search tab is a button (it focuses the home search rather than
          // doing a traditional route-change); the rest are Links so
          // prefetching still kicks in.
          if (tab.onClick) {
            return (
              <button key={i} onClick={tab.onClick} className={sharedClass} aria-label={tab.label}>
                {body}
              </button>
            )
          }
          return (
            <Link key={i} href={tab.href} className={sharedClass} aria-label={tab.label}>
              {body}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
