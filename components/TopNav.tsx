'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useCart } from '@/lib/cartContext'
import { useBi, useLanguage } from '@/lib/languageContext'
import CityDropdown from './CityDropdown'
import LanguageToggle from './LanguageToggle'
import SideMenu from './SideMenu'
import { useMode, type DashboardTab } from '@/lib/modeContext'
import { useDataMode } from '@/lib/dataMode'
import { navFor, navLabel, type NavDestination } from '@/lib/navConfig'
import { pickBi } from '@/lib/languageContext'
import type { Locale } from '@/lib/translations'
import {
  ADMIN_TILES, ADMIN_ROWS, ADMIN_TAB_LABELS, ADMIN_TAB_ICONS,
  isAdminRole, visibleAdminTabs, type AdminSubTab,
} from '@/lib/adminNav'

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
  // The ☰ side menu (components/SideMenu.tsx).
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = useCallback(() => setMenuOpen(false), [])

  const {
    effectiveMode, hasRestaurantRole, topRole, dashboardTab, setDashboardTab,
    adminTab, setAdminTab,
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
        if (isAdminRole(sessionUser.role)) {
          // Admins get the admin bar below; they have no vendor CTA and
          // never hit the vendor endpoint.
          setVendor({ kind: 'none' })
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
  // Map icon only on the restaurant list (the one map-bearing page).
  // In Pro mode the TopNav shows operations links instead.
  const showMapBtn  = effectiveMode === 'client'
                    && pathname === '/restaurants'

  // Nav row. Same source as the mobile BottomNav — see lib/navConfig.ts.
  // This bar renders the ROUTE destinations only: Search stays the inline
  // form below (the overlay is mobile-only), so `openSearch` entries are
  // filtered out here.
  const destinations: NavDestination[] =
    navFor(effectiveMode, topRole, hasRestaurantRole).filter(d => !d.actionKey)

  // Tapping a dashboard-tab link flips context state and (if needed)
  // routes to /dashboard. Navigating while already on /dashboard is a
  // same-route no-op, so we just update state there.
  const goToDashTab = (next: DashboardTab) => {
    setDashboardTab(next)
    if (!isDashboard) router.push('/dashboard')
  }

  // ── Admin bar ────────────────────────────────────────────────────────────
  // An admin session gets a completely different bar: the admin nav, not the
  // customer chrome. Before this, `me.role` was read only to skip the vendor
  // probe, and the nav row still came from navFor(effectiveMode) — which
  // resolves to 'client' for an admin (they hold no team role), so they were
  // shown Restaurants / Events / Cart / Search / the city picker, none of
  // which means anything to them.
  const isAdmin = isAdminRole(me?.role)
  const isAccount = pathname === '/account'

  // ONE filter, applied to each half. ADMIN_TILES are the primary links and
  // ADMIN_ROWS the ⋯ contents; the split and the ordering both come from
  // lib/adminNav.ts, which is also what the account page renders from, so
  // the bar and the panels cannot disagree about what exists.
  //
  // A role that may not open a tab sees it in NEITHER surface — a moderator
  // gets 2 primary (no Accounts) and 5 in the ⋯. Presentation only: the
  // admin API routes do their own authorization regardless.
  const adminPrimary = visibleAdminTabs(me?.role, ADMIN_TILES)
  const adminMore    = visibleAdminTabs(me?.role, ADMIN_ROWS)

  // Structurally identical to goToDashTab above, for the identical reason:
  // Next treats /account?tab=a and ?tab=b as one route and skips the
  // re-render, so the selection is context state and only the cross-route
  // case goes through the router. setAdminTab pushes the ?tab= history entry
  // itself, but only while on /account (see lib/modeContext.tsx).
  const goToAdminTab = (next: AdminSubTab) => {
    setAdminTab(next)
    if (!isAccount) router.push(`/account?tab=${next}`)
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
          ☰ menu (left, with a dot when the restaurant has orders waiting) ·
          "Tchop & Ndjoka", nothing else (V3). Log in / account, city,
          language, WhatsApp and the Pro entries live in the ☰ menu
          (components/SideMenu.tsx). Admins keep a bare bar: their navigation
          is the console on /account. */}
      <div className="md:hidden px-2 h-12 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 min-w-0">
          {!isAdmin && <MenuButton onClick={() => setMenuOpen(true)} badge={pendingCount} label={bi('Menu', 'Menu')} />}
          <Link href={isAdmin ? '/account' : '/'} className="font-black text-brand tracking-tight truncate px-1">
            Tchop &amp; Ndjoka
          </Link>
        </div>
      </div>

      {/* ── Desktop ADMIN bar (md+) ─────────────────────────────────────
          The admin nav, in the top bar, as the SINGLE place it lives on
          desktop. The in-page tab row that used to duplicate it is gone.

          WIDTH: max-w-5xl, matching the admin page body, and deliberately
          NOT the max-w-2xl the customer bar uses. That 2xl box does not
          actually contain its own children — the shrink-0 nav overflows it
          by ~260px at 1280 (measured: box 304→976, content 320→1238), which
          is invisible only because the header is full-bleed. Inheriting it
          here would leave the bar and the 5xl body misaligned by 176px on
          each side, so the admin branch takes a width it fits inside.

          NOT here, on purpose: the city dropdown, the search field and the
          cart. All three are customer surfaces — an admin filters by city
          inside the panels that have their own city select, searches inside
          the panel they are looking at, and cannot place an order at all.

          Identity and Sign out are NOT here either: they stay in the
          account page's own md+ hello header, which is shared with the
          customer and vendor views and is left untouched. */}
      {isAdmin && (
        <div className="hidden max-w-5xl mx-auto px-3 sm:px-4 h-14 md:flex items-center gap-2 sm:gap-4">
          {/* Points at /account, not / — middleware.ts bounces an admin from
              / straight back to /account, so a logo linking there would be a
              visible round trip to nowhere. */}
          <Link href="/account" className="flex items-center gap-1 flex-shrink-0" aria-label="Tchop &amp; Ndjoka — admin console">
            <span className="text-brand font-black tracking-tight text-lg sm:text-xl">T&amp;N</span>
            <span className="hidden lg:inline font-bold text-ink-primary text-sm">Tchop &amp; Ndjoka</span>
          </Link>

          <nav className="flex items-center gap-1 flex-1 whitespace-nowrap" aria-label={bi('Navigation administration', 'Admin navigation')}>
            {adminPrimary.map(tab => (
              <TopNavButton
                key={tab}
                onClick={() => goToAdminTab(tab)}
                // Only /account renders a panel, so nothing is "current"
                // while the admin is off on a public page.
                active={isAccount && adminTab === tab}
              >
                {ADMIN_TAB_ICONS[tab]} {pickBi(ADMIN_TAB_LABELS[tab], locale)}
              </TopNavButton>
            ))}

            {adminMore.length > 0 && (
              <AdminMoreMenu
                tabs={adminMore}
                current={isAccount ? adminTab : null}
                locale={locale}
                label={bi('Plus', 'More')}
                onSelect={goToAdminTab}
              />
            )}
          </nav>

          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
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
            <LanguageToggle />
          </div>
        </div>
      )}

      {/* ── Desktop bar (md+), customer mode (V3) ──────────────────────────
          Same as mobile: ☰ + "Tchop & Ndjoka". Everything else is in the ☰
          menu. The one page tool kept is the map toggle on /restaurants,
          the only way to open its map on desktop. */}
      {!isAdmin && effectiveMode === 'client' && (
        <div className="hidden md:flex max-w-5xl mx-auto px-4 h-14 items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <MenuButton onClick={() => setMenuOpen(true)} badge={pendingCount} label={bi('Menu', 'Menu')} />
            <Link href="/" className="font-black text-brand tracking-tight text-xl truncate">
              Tchop &amp; Ndjoka
            </Link>
          </div>
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
        </div>
      )}

      {/* ── Desktop bar (md+), Pro mode — the restaurant's operations tabs
          (orders, menu, settings…) stay: on desktop they are the only way
          between dashboard tabs. ─────────────────────────────────────── */}
      <div className={`${isAdmin || effectiveMode === 'client' ? 'hidden' : 'hidden md:flex'} max-w-2xl mx-auto px-3 sm:px-4 h-14 items-center gap-2 sm:gap-4`}>

        <MenuButton onClick={() => setMenuOpen(true)} badge={pendingCount} label={bi('Menu', 'Menu')} />

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

        {/* Desktop-only inline search — submits to /restaurants?q=...#search so the
            home page seeds its own search input. On pages other than /,
            this is a jump-to-results shortcut. Hidden on mobile; the
            home page search input + BottomNav Search tab cover mobile.
            Also hidden in Pro mode — vendors manage their own
            restaurant and don't discover other venues from here. */}
        {effectiveMode === 'client' && (
          <form
            onSubmit={e => {
              e.preventDefault()
              const q = searchDraft.trim()
              router.push(q ? `/restaurants?q=${encodeURIComponent(q)}#search` : '/restaurants')
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
            const active = d.match(pathname, dashboardTab)

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

          {/* Language toggle — also in the ☰ menu. */}
          <LanguageToggle />
        </div>
      </div>

      {!isAdmin && (
        <SideMenu open={menuOpen} onClose={closeMenu} user={me ? { name: me.name, role: me.role } : null} pendingCount={pendingCount} />
      )}
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

// ── The ⋯ menu ──────────────────────────────────────────────────────────────
// Holds the eight secondary admin destinations, filtered by the caller.
//
// Deliberately the SAME pattern as components/CityDropdown.tsx rather than a
// new one: a ref'd root, mousedown-outside and Escape to close, a real
// <button> per item so Tab and Enter work without any key handling of our
// own, and aria-haspopup/aria-expanded on the trigger. Nothing here depends
// on focus trapping, portals or a click-away library.
function AdminMoreMenu({
  tabs, current, locale, label, onSelect,
}: {
  tabs: AdminSubTab[]
  /** The open panel, or null when the admin is off /account and nothing is
   *  current. Drives the ✓ and the highlight. */
  current: AdminSubTab | null
  locale: Locale
  label: string
  onSelect: (t: AdminSubTab) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // A selection inside the menu is also active state on the trigger, so the
  // admin can tell at a glance that the open panel came from in here.
  const currentIsInside = current != null && tabs.includes(current)

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={`px-3 py-1.5 rounded-full text-sm font-semibold transition-colors ${
          currentIsInside || open
            ? 'bg-brand-light text-brand-darker'
            : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-muted'
        }`}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full mt-2 left-0 min-w-[14rem] bg-surface border border-divider rounded-2xl shadow-card py-1 z-50"
        >
          {tabs.map(tab => {
            const selected = tab === current
            return (
              <button
                key={tab}
                role="menuitem"
                onClick={() => { onSelect(tab); setOpen(false) }}
                className={`w-full text-left px-4 py-2 text-sm transition-colors flex items-center gap-2 ${
                  selected
                    ? 'bg-brand-light text-brand-darker font-semibold'
                    : 'text-ink-primary hover:bg-surface-muted'
                }`}
              >
                <span aria-hidden="true">{ADMIN_TAB_ICONS[tab]}</span>
                <span className="flex-1">{pickBi(ADMIN_TAB_LABELS[tab], locale)}</span>
                {selected && <span aria-hidden="true">✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ☰ — opens the side menu. A dot when the viewer's restaurant has orders
// waiting (the count is on "Commandes du restaurant" inside).
function MenuButton({ onClick, badge, label }: { onClick: () => void; badge: number; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={badge > 0 ? `${label} (${badge})` : label} title={label}
      className="relative w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-full text-xl text-ink-primary hover:bg-surface-muted transition-colors">
      <span aria-hidden="true">☰</span>
      {badge > 0 && <span className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-brand ring-2 ring-surface" aria-hidden="true" />}
    </button>
  )
}

