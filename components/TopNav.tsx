'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useCart } from '@/lib/cartContext'
import { useBi, useLanguage } from '@/lib/languageContext'
import CityDropdown from './CityDropdown'
import LanguageToggle from './LanguageToggle'
import { useMode, type DashboardTab } from '@/lib/modeContext'
import { useDataMode } from '@/lib/dataMode'
import { navFor, navLabel, type NavDestination } from '@/lib/navConfig'

interface TopNavProps {
  // Retained for compatibility with pages that pass a Join CTA. New layout
  // shows it as a secondary action on desktop only; mobile relies on the
  // bottom nav + "Mon restaurant" inline action.
  cta?: { label: string; href: string }
}

interface SessionUser { id: string; name: string; role: string }

type VendorState =
  | { kind: 'none' }                      // logged-out, customer with no restaurants, or admin
  | { kind: 'approved' }                  // ≥1 approved restaurant → /dashboard CTA
  | { kind: 'pending'  }                  // restaurants exist but all pending → /account CTA

export default function TopNav({ cta }: TopNavProps = {}) {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const { totalItems } = useCart()
  const bi = useBi()
  const { locale } = useLanguage()

  const [me, setMe] = useState<SessionUser | null>(null)
  const [vendor, setVendor] = useState<VendorState>({ kind: 'none' })
  const [searchDraft, setSearchDraft] = useState('')
  // Mirror of the mobile BottomNav's vendor pending count so the desktop
  // Orders link can surface the same red badge. Polled every 30s to
  // match the mobile cadence; poll is only started when the viewer
  // actually owns/manages an approved restaurant.
  const [pendingCount, setPendingCount] = useState(0)

  const {
    effectiveMode, hasRestaurantRole, topRole, dashboardTab, setDashboardTab,
  } = useMode()
  const { isLowData, toggle: toggleLowData } = useDataMode()

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

  // Pending-count poll lives in its own effect so a pure customer (no
  // restaurant_team role) never pings the vendor endpoint. Mirrors the
  // BottomNav gate.
  useEffect(() => {
    if (!hasRestaurantRole) {
      setPendingCount(0)
      return
    }
    let cancelled = false
    const refreshCount = async () => {
      try {
        const r = await fetch('/api/vendor/pending-count', { cache: 'no-store' })
        const d = await r.json()
        if (!cancelled) setPendingCount(Number(d?.count ?? 0))
      } catch { /* transient network; keep prior count */ }
    }
    refreshCount()
    const t = setInterval(refreshCount, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [hasRestaurantRole])

  const isDashboard = pathname.startsWith('/dashboard')
  // Map icon only makes sense on the two map-bearing client-mode surfaces.
  // In restaurant mode the TopNav shows operations links instead.
  const showMapBtn  = effectiveMode === 'client'
                    && (pathname === '/' || pathname === '/events')
  const isOwner   = topRole === 'owner'
  const isManager = topRole === 'manager'

  // Nav row. Same source as the mobile BottomNav — see lib/navConfig.ts.
  // This bar renders the ROUTE destinations only: Search stays the inline
  // form below (the overlay is mobile-only), so `openSearch` entries are
  // filtered out here.
  const destinations: NavDestination[] =
    navFor(effectiveMode, topRole).filter(d => !d.actionKey)

  // ── Legacy extras — TEMPORARY ───────────────────────────────────────────
  // Vouchers and Settings are not in navConfig yet, so they're appended
  // after the shared set instead of being modelled. They exist only on this
  // bar; the BottomNav reaches them through /dashboard's own tab strip.
  // Remove this block (and the suppression below) when they migrate.
  const isDashVouchers = isDashboard && (dashboardTab === 'vouchers' || dashboardTab === 'validate')
  const isDashSettings = isDashboard && dashboardTab === 'settings'
  // navConfig's Orders match is "on /dashboard and not the Menu tab", which
  // would also light up while an extra is selected. Suppress it so exactly
  // one pill reads as active. Goes away with the extras.
  const legacyExtraActive = isDashVouchers || isDashSettings

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
    <header className="sticky top-0 z-30 bg-surface border-b border-divider md:shadow-sm">

      {/* ── Mobile bar (< md) ────────────────────────────────────────────
          Deliberately spare: city picker on the left, notification bell on
          the right, nothing else. The logo, search field, language toggle
          and map button all moved off mobile — search lives in the
          BottomNav overlay, the language switch in Account → Profil, and
          the map is desktop-only now. Compact 48px height so the cuisine
          row below it sits above the fold. */}
      <div className="md:hidden px-4 h-12 flex items-center justify-between gap-2">
        <CityDropdown />
        <Link
          href="/account"
          aria-label={
            pendingCount > 0
              ? bi(`Notifications — ${pendingCount} en attente`, `Notifications — ${pendingCount} pending`)
              : bi('Notifications', 'Notifications')
          }
          className="relative w-10 h-10 -mr-2 flex items-center justify-center rounded-full text-xl hover:bg-surface-muted transition-colors"
        >
          <span aria-hidden="true">🔔</span>
          {pendingCount > 0 && (
            <span className={`absolute top-1 right-1 rounded-full bg-brand text-white font-bold flex items-center justify-center leading-none ring-2 ring-surface ${
              pendingCount > 9 ? 'h-5 min-w-5 text-[10px] px-1' : 'h-4 w-4 text-[10px]'
            }`}>
              {pendingCount > 99 ? '99+' : pendingCount}
            </span>
          )}
        </Link>
      </div>

      {/* ── Desktop bar (md+) — unchanged by the mobile redesign ───────── */}
      <div className="hidden max-w-2xl mx-auto px-3 sm:px-4 h-14 md:flex items-center gap-2 sm:gap-4">

        {/* Logo — orange T&N text, never hidden. Compact on mobile. */}
        <Link href="/" className="flex items-center gap-1 flex-shrink-0" aria-label="Tchop &amp; Ndjoka — home">
          <span className="text-brand font-black tracking-tight text-lg sm:text-xl">T&amp;N</span>
          <span className="hidden lg:inline font-bold text-ink-primary text-sm">Tchop &amp; Ndjoka</span>
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
            home page search input + BottomNav Search tab cover mobile.
            Also hidden in restaurant mode — vendors manage their own
            restaurant and don't discover other venues from here. */}
        {effectiveMode === 'client' && (
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
        )}

        {/* Desktop-only nav links. Hidden on mobile — BottomNav covers these.
            `flex-shrink-0` + `whitespace-nowrap` keep every link visible even
            when the search input tries to grow and squeeze the cluster.
            The link set depends on the active mode: client-mode shows the
            public browse surface; restaurant-mode shows operations tabs
            gated by the user's highest team role. */}
        <nav className="hidden md:flex items-center gap-1 flex-shrink-0 whitespace-nowrap">
          {destinations.map(d => {
            const label = navLabel(d, locale)
            const badge = d.badgeKey === 'pendingOrders' ? pendingCount
              : d.badgeKey === 'cartCount' ? totalItems
                : undefined
            const active = d.key === 'orders'
              ? d.match(pathname, dashboardTab) && !legacyExtraActive
              : d.match(pathname, dashboardTab)

            // Dashboard destinations flip context state rather than routing
            // to a ?tab= URL, which Next.js treats as the same route.
            if (d.dashboardTab) {
              const tab = d.dashboardTab
              return (
                <TopNavButton key={d.key} onClick={() => goToDashTab(tab)} active={active} badge={badge}>
                  {d.icon} {label}
                </TopNavButton>
              )
            }
            return (
              <TopNavLink key={d.key} href={d.href ?? '/'} active={active} badge={badge}>
                {d.icon} {label}
              </TopNavLink>
            )
          })}

          {/* Legacy extras — TEMPORARY, see the note above. */}
          {effectiveMode === 'restaurant' && (isOwner || isManager) && (
            <TopNavButton onClick={() => goToDashTab('vouchers')} active={isDashVouchers}>
              🎫 {bi('Bons', 'Vouchers')}
            </TopNavButton>
          )}
          {effectiveMode === 'restaurant' && isOwner && (
            <TopNavButton onClick={() => goToDashTab('settings')} active={isDashSettings}>
              ⚙️ {bi('Paramètres', 'Settings')}
            </TopNavButton>
          )}
        </nav>

        {/* Right cluster. The cart and account pills that used to live here
            are gone — both are navConfig destinations now and render in the
            nav row above, so keeping them here was a duplicate entry point
            for the same route. */}
        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
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

          {/* Low-data indicator — only shows when the toggle is on.
              Tappable to flip it back off without going to /account. */}
          {isLowData && (
            <button
              type="button"
              onClick={toggleLowData}
              title={bi('Mode économique actif', 'Low-data mode on')}
              aria-label={bi('Mode économique actif', 'Low-data mode on')}
              className="w-9 h-9 rounded-full flex items-center justify-center bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors"
            >
              📶
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

// Count pill over a nav item's top-right corner. Shared by the link and
// button variants so the cart count and the pending-order count look the
// same, and match the BottomNav badge.
function TopNavBadge({ badge, label }: { badge: number; label: string }) {
  const sizeCls = badge > 9 ? 'h-5 min-w-5 text-[10px] px-1' : 'h-4 w-4 text-[10px]'
  return (
    <span
      aria-label={label}
      className={`absolute -top-1 -right-1 ${sizeCls} rounded-full bg-danger text-white font-bold flex items-center justify-center leading-none ring-2 ring-surface`}
    >
      {badge > 99 ? '99+' : badge}
    </span>
  )
}

function TopNavLink({
  href,
  active,
  badge,
  children,
}: {
  href: string
  active: boolean
  badge?: number
  children: React.ReactNode
}) {
  const hasBadge = badge != null && badge > 0
  return (
    <Link
      href={href}
      className={`relative px-3 py-1.5 rounded-full text-sm font-semibold transition-colors ${
        active
          ? 'bg-brand-light text-brand-darker'
          : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-muted'
      }`}
    >
      {children}
      {hasBadge && <TopNavBadge badge={badge as number} label={`${badge}`} />}
    </Link>
  )
}

// Dashboard-tab variant — no href, flips ModeContext state. Keeps
// dashboard tab switching instant instead of bouncing through the
// router, which Next.js skips for same-route ?tab= changes. Supports
// an optional badge that's absolutely-positioned over the top-right
// corner of the pill, matching the BottomNav style.
function TopNavButton({
  onClick,
  active,
  badge,
  children,
}: {
  onClick: () => void
  active: boolean
  badge?: number
  children: React.ReactNode
}) {
  const hasBadge = badge != null && badge > 0
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-3 py-1.5 rounded-full text-sm font-semibold transition-colors ${
        active
          ? 'bg-brand-light text-brand-darker'
          : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-muted'
      }`}
    >
      {children}
      {hasBadge && <TopNavBadge badge={badge as number} label={`${badge} pending`} />}
    </button>
  )
}
