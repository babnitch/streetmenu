'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useCart } from '@/lib/cartContext'
import LanguageToggle from './LanguageToggle'
import CityDropdown from './CityDropdown'

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
  const { totalItems } = useCart()

  const [me, setMe] = useState<SessionUser | null>(null)
  const [vendor, setVendor] = useState<VendorState>({ kind: 'none' })

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

  const accountLabel = me ? firstName(me.name) || me.name : 'Connexion / Login'
  const isOrdersPage = pathname === '/account'
  const isDashboard  = pathname.startsWith('/dashboard')

  return (
    <header className="sticky top-0 z-30 bg-surface border-b border-divider shadow-sm">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 h-14 flex items-center gap-2 sm:gap-4">

        {/* Logo — orange N&T text, never hidden. Compact on mobile. */}
        <Link href="/" className="flex items-center gap-1 flex-shrink-0" aria-label="Ndjoka &amp; Tchop — home">
          <span className="text-brand font-black tracking-tight text-lg sm:text-xl">N&amp;T</span>
          <span className="hidden lg:inline font-bold text-ink-primary text-sm">Ndjoka &amp; Tchop</span>
        </Link>

        {/* City dropdown — shown on every viewport; this is the primary
            global filter for the restaurant list. */}
        <div className="flex-1 flex justify-center sm:justify-start sm:ml-4">
          <CityDropdown />
        </div>

        {/* Desktop-only nav links. Hidden on mobile — BottomNav covers these. */}
        <nav className="hidden md:flex items-center gap-1">
          <TopNavLink href="/account?tab=orders" active={isOrdersPage}>
            📦 Commandes
          </TopNavLink>
          {vendor.kind === 'approved' && (
            <TopNavLink href="/dashboard" active={isDashboard}>
              🏪 Restaurant
            </TopNavLink>
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
          <Link
            href="/account"
            className="text-ink-secondary hover:text-ink-primary text-sm font-semibold transition-colors flex items-center gap-1 max-w-[7rem] sm:max-w-[10rem] px-1 sm:px-2"
            title={me?.name ?? 'Connexion / Login'}
          >
            <span aria-hidden="true">👤</span>
            <span className="truncate">{accountLabel}</span>
          </Link>
          <span className="hidden sm:block"><LanguageToggle /></span>

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
