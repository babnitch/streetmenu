'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useCart } from '@/lib/cartContext'
import { useBi } from '@/lib/languageContext'
import CityDropdown from './CityDropdown'
import LanguageToggle from './LanguageToggle'
import { useMode, type DashboardTab } from '@/lib/modeContext'

interface TopNavProps {
  // Retained for compatibility with pages that pass a Join CTA. New layout
  // shows it as a secondary action on desktop only; mobile relies on the
  // bottom nav + "Mon restaurant" inline action.
  cta?: { label: string; href: string }
}

interface SessionUser { id: string; name: string; role: string }

// Strips "Babette Nitcheu" → "Babette" so the name pill stays compact.
function firstName(full: string): string {
  const t = full.trim()
  if (!t) return ''
  return t.split(/\s+/)[0]
}

type VendorState =
  | { kind: 'none' }                      // logged-out, customer with no restaurants, or admin
  | { kind: 'approved' }                  // ≥1 approved restaurant → /dashboard CTA
  | { kind: 'pending'  }                  // restaurants exist but all pending → /account CTA

export default function TopNav({ cta }: TopNavProps = {}) {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const { totalItems } = useCart()
  const bi = useBi()

  const [me, setMe] = useState<SessionUser | null>(null)
  const [vendor, setVendor] = useState<VendorState>({ kind: 'none' })
  const [searchDraft, setSearchDraft] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const meRes = await fetch('/api/auth/me', { cache: 'no-store' })
        const data = await meRes.json()
        if (cancelled) return
        const sessionUser = (data?.user ?? null) as SessionUser | null
        setMe(sessionUser)
        if (!sessionUser) { setVendor({ kind: 'none' }); return }
        if (['super_admin', 'admin', 'moderator'].includes(sessionUser.role)) {
          setVendor({ kind: 'none' })  // admins navigate via /account admin tabs
          return
        }
        const vRes = await fetch('/api/vendor/restaurants', { cache: 'no-store' })
        const v = await vRes.json()
        if (cancelled) return
        const list: Array<{ status?: string }> = v.restaurants ?? []
        if (!list.length) { setVendor({ kind: 'none' }); return }
        const allPending = list.every(r => r.status === 'pending')
        setVendor({ kind: allPending ? 'pending' : 'approved' })
      } catch {
        if (!cancelled) { setVendor({ kind: 'none' }); setMe(null) }
      }
    })()
    return () => { cancelled = true }
  }, [])

  const { mode, hasRestaurantRole, topRole, dashboardTab, setDashboardTab } = useMode()

  const accountLabel = me ? firstName(me.name) || me.name : bi('Connexion', 'Login')
  const isRestaurants = pathname === '/'
  const isOrdersPage  = pathname === '/account'
  const isDashboard   = pathname.startsWith('/dashboard')
  const isEvents      = pathname === '/events' || pathname.startsWith('/events/')
  // Map icon only makes sense on the two map-bearing client-mode surfaces.
  // In restaurant mode the TopNav shows operations links instead.
  const showMapBtn    = (mode === 'client' || !hasRestaurantRole)
                      && (pathname === '/' || pathname === '/events')
  // Restaurant mode is only honored for users who actually have a team role
  // — the provider's `hasRestaurantRole` gate + this fallback keep the
  // restaurant UI out of the way for pure customers.
  const effectiveMode: 'client' | 'restaurant' =
    hasRestaurantRole && mode === 'restaurant' ? 'restaurant' : 'client'
  const isOwner   = topRole === 'owner'
  const isManager = topRole === 'manager'
  // Dashboard tab helpers — source of truth is ModeContext, not
  // window.location, because encoding the tab in ?tab= caused
  // Next.js to treat /dashboard?tab=a and /dashboard?tab=b as the
  // same route and skip re-render, leading to missed clicks.
  const isDashOrders   = isDashboard && dashboardTab === 'orders'
  const isDashMenu     = isDashboard && dashboardTab === 'menu'
  const isDashTeam     = isDashboard && dashboardTab === 'team'
  const isDashSettings = isDashboard && dashboardTab === 'settings'

  // Tapping a dashboard-tab link flips context state and (if needed)
  // routes to /dashboard. Navigating while already on /dashboard is a
  // same-route no-op, so we just update state there.
  const goToDashTab = (next: DashboardTab) => {
    setDashboardTab(next)
    if (!isDashboard) router.push('/dashboard')
  }

  // Map toggle — rendered on the home and events pages. Dispatches a
  // custom event the page listens for; keeps TopNav decoupled from the
  // page-local showMap state.
  const toggleMap = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nt-toggle-map'))
    }
  }

  return (
    <header className="sticky top-0 z-30 bg-surface border-b border-divider shadow-sm">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 h-14 flex items-center gap-2 sm:gap-4">

        {/* Logo — orange N&T text, never hidden. Compact on mobile. */}
        <Link href="/" className="flex items-center gap-1 flex-shrink-0" aria-label="Ndjoka &amp; Tchop — home">
          <span className="text-brand font-black tracking-tight text-lg sm:text-xl">N&amp;T</span>
          <span className="hidden lg:inline font-bold text-ink-primary text-sm">Ndjoka &amp; Tchop</span>
        </Link>

        {/* City dropdown — primary global filter. On mobile this row is
            Logo | (centered city) | Map, so the wrapper grows + centers
            its content. On desktop the search input takes the flex-1
            role (just below), so the city collapses to its natural
            width and sits next to the logo. */}
        <div className="flex-1 md:flex-none flex justify-center md:justify-start">
          <CityDropdown />
        </div>

        {/* Desktop-only inline search — submits to /?q=...#search so the
            home page seeds its own search input. On pages other than /,
            this is a jump-to-results shortcut. Hidden on mobile; the
            home page search input + BottomNav Search tab cover mobile. */}
        <form
          onSubmit={e => {
            e.preventDefault()
            const q = searchDraft.trim()
            router.push(q ? `/?q=${encodeURIComponent(q)}#search` : '/')
          }}
          className="hidden md:flex flex-1 max-w-md"
          role="search"
        >
          <label className="relative block w-full">
            <span className="absolute inset-y-0 left-3 flex items-center text-ink-tertiary pointer-events-none">🔍</span>
            <input
              type="search"
              value={searchDraft}
              onChange={e => setSearchDraft(e.target.value)}
              placeholder={bi('Rechercher un restaurant…', 'Search restaurants…')}
              className="w-full bg-surface-muted border border-transparent focus:border-brand focus:bg-surface rounded-full pl-9 pr-4 py-2 text-sm text-ink-primary placeholder-ink-tertiary outline-none transition-colors"
            />
          </label>
        </form>

        {/* Desktop-only nav links. Hidden on mobile — BottomNav covers these.
            `flex-shrink-0` + `whitespace-nowrap` keep every link visible even
            when the search input tries to grow and squeeze the cluster.
            The link set depends on the active mode: client-mode shows the
            public browse surface; restaurant-mode shows operations tabs
            gated by the user's highest team role. */}
        <nav className="hidden md:flex items-center gap-1 flex-shrink-0 whitespace-nowrap">
          {effectiveMode === 'client' && (
            <>
              <TopNavLink href="/" active={isRestaurants}>
                🏠 {bi('Restaurants', 'Restaurants')}
              </TopNavLink>
              <TopNavLink href="/events" active={isEvents}>
                🎉 {bi('Événements', 'Events')}
              </TopNavLink>
              {me && (
                <TopNavLink href="/account?tab=orders" active={isOrdersPage}>
                  📦 {bi('Commandes', 'Orders')}
                </TopNavLink>
              )}
            </>
          )}
          {effectiveMode === 'restaurant' && (
            <>
              <TopNavButton onClick={() => goToDashTab('orders')} active={isDashOrders || (isDashboard && !isDashMenu && !isDashTeam && !isDashSettings)}>
                📦 {bi('Commandes', 'Orders')}
              </TopNavButton>
              {(isOwner || isManager) && (
                <TopNavButton onClick={() => goToDashTab('menu')} active={isDashMenu}>
                  🍽️ {bi('Menu', 'Menu')}
                </TopNavButton>
              )}
              {isOwner && (
                <>
                  <TopNavButton onClick={() => goToDashTab('team')} active={isDashTeam}>
                    👥 {bi('Équipe', 'Team')}
                  </TopNavButton>
                  <TopNavButton onClick={() => goToDashTab('settings')} active={isDashSettings}>
                    ⚙️ {bi('Paramètres', 'Settings')}
                  </TopNavButton>
                </>
              )}
            </>
          )}
        </nav>

        {/* Right cluster */}
        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          {totalItems > 0 && (
            <Link
              href="/order"
              className="bg-brand hover:bg-brand-dark text-white rounded-full px-3 py-1.5 text-sm font-semibold flex items-center gap-1.5 transition-colors"
            >
              🛒 {totalItems}
            </Link>
          )}
          {/* Account pill — desktop only. Mobile has Account in BottomNav
              so showing it here too created a duplicate entry point. */}
          <Link
            href="/account"
            className="hidden md:flex text-ink-secondary hover:text-ink-primary text-sm font-semibold transition-colors items-center gap-1 max-w-[10rem] px-2"
            title={me?.name ?? bi('Connexion', 'Login')}
          >
            <span aria-hidden="true">👤</span>
            <span className="truncate">{accountLabel}</span>
          </Link>
          {/* Secondary Join CTA on desktop only when the page passed one
              AND the visitor isn't already a vendor. */}
          {cta && vendor.kind === 'none' && me === null && (
            <Link
              href={cta.href}
              className="hidden md:block bg-brand hover:bg-brand-dark text-white text-sm font-semibold px-4 py-2 rounded-full transition-colors"
            >
              {cta.label}
            </Link>
          )}

          {/* Map toggle — home and events routes. */}
          {showMapBtn && (
            <button
              type="button"
              onClick={toggleMap}
              aria-label={bi('Carte', 'Map')}
              title={bi('Carte', 'Map')}
              className="w-9 h-9 rounded-full flex items-center justify-center bg-brand-light text-brand-dark border border-brand-badge hover:bg-brand-badge/40 transition-colors"
            >
              🗺
            </button>
          )}

          {/* Language toggle — last in the cluster, visible on every page
              and every breakpoint. Secondary copy lives in /account. */}
          <LanguageToggle />
        </div>
      </div>
    </header>
  )
}

function TopNavLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-full text-sm font-semibold transition-colors ${
        active
          ? 'bg-brand-light text-brand-darker'
          : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-muted'
      }`}
    >
      {children}
    </Link>
  )
}

// Dashboard-tab variant — no href, flips ModeContext state. Keeps
// dashboard tab switching instant instead of bouncing through the
// router, which Next.js skips for same-route ?tab= changes.
function TopNavButton({
  onClick,
  active,
  children,
}: {
  onClick: () => void
  active: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-sm font-semibold transition-colors ${
        active
          ? 'bg-brand-light text-brand-darker'
          : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-muted'
      }`}
    >
      {children}
    </button>
  )
}
