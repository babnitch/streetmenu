'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

// Mobile-only fixed bottom tab bar. Slots (up to 6):
//   🏠 Home · 🔍 Search · 🎉 Events · 📦 Orders · 🏪 Restaurant (vendor) · 👤 Account
// Hidden at md+ (≥768px) — the TopNav takes over there.
//
// Icon-only, no labels: with 5–6 tabs the text overlapped on 375px
// screens. Uber Eats follows the same pattern on small screens; the
// aria-label keeps it accessible.
//
// "Restaurant" slot only renders for customers with ≥1 non-pending
// approved restaurant. Admins and pending-only vendors see a 5-tab bar
// (Restaurant slot collapses).

interface TabSpec {
  href:   string
  icon:   string
  label:  string            // used for aria-label + title only (not rendered)
  match:  (path: string) => boolean
  onClick?: () => void      // Search uses this instead of href-nav
  badge?: number            // red pill on icon top-right when > 0
}

export default function BottomNav() {
  const pathname = usePathname() ?? ''
  const router = useRouter()

  const [showVendorTab, setShowVendorTab] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
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
    { href: '/events',              icon: '🎉', label: 'Événements / Events', match: p => p.startsWith('/events') },
    { href: '/account?tab=orders',  icon: '📦', label: 'Commandes / Orders', match: p => p === '/account' && (typeof window !== 'undefined' && window.location.search.includes('tab=orders')) },
    ...(showVendorTab ? [
      {
        href: '/dashboard',
        icon: '🏪',
        label: 'Restaurant',
        match: (p: string) => p.startsWith('/dashboard'),
        badge: pendingCount,
      }
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
          // Active icon: full-opacity, with a subtle brand-light bubble
          // + brand-dot underline for clear selection. Inactive: slight
          // grayscale so the active tab pops.
          const iconCls = active
            ? 'opacity-100 scale-110'
            : 'opacity-60 grayscale'
          const sharedClass = 'relative flex items-center justify-center min-h-[56px] min-w-[44px] px-2'

          const body = (
            <>
              <span
                aria-hidden="true"
                className={`text-2xl leading-none transition-transform ${iconCls}`}
              >
                {tab.icon}
              </span>
              {active && (
                <span className="absolute bottom-2 h-1 w-1 rounded-full bg-brand" aria-hidden="true" />
              )}
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
