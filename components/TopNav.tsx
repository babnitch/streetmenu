'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useCart } from '@/lib/cartContext'
import { useLanguage } from '@/lib/languageContext'
import LanguageToggle from './LanguageToggle'

interface TopNavProps {
  cta?: { label: string; href: string }
}

// When the page hands us the "+ Join Us" CTA, we may need to swap it:
//   - logged-out users or customers with no restaurant → keep it
//   - customers with ≥1 restaurant → "Mon restaurant / My Restaurant" →
//     /dashboard for approved owners, /account for pending-only
//   - admins / moderators → hide entirely (they have their own dashboard)
type JoinSwap =
  | { kind: 'join' }                                    // show incoming CTA unchanged
  | { kind: 'myRestaurant'; pending: boolean }          // customer owns at least one
  | { kind: 'hidden' }                                  // admin role or still resolving

// Session user fetched via /api/auth/me (the real customer/admin JWT flow).
// lib/authContext is Supabase-auth backed and always null for this app —
// reading /api/auth/me directly is what every other page does.
interface SessionUser { id: string; name: string; role: string }

// Pick the first space-delimited token; if long, it's still readable on
// mobile (~10 chars). Keeps the nav compact for people with full names.
function firstName(full: string): string {
  const t = full.trim()
  if (!t) return ''
  return t.split(/\s+/)[0]
}

export default function TopNav({ cta }: TopNavProps = {}) {
  const pathname = usePathname()
  const { totalItems } = useCart()
  const { t } = useLanguage()

  const isRestaurants = pathname === '/' || pathname.startsWith('/restaurant')
  const isEvents      = pathname.startsWith('/events')

  const [swap, setSwap] = useState<JoinSwap>({ kind: 'join' })
  const [me, setMe] = useState<SessionUser | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const meRes = await fetch('/api/auth/me', { cache: 'no-store' })
        const data = await meRes.json()
        if (cancelled) return
        const sessionUser = (data?.user ?? null) as SessionUser | null
        setMe(sessionUser)
        if (!sessionUser) { setSwap({ kind: 'join' }); return }
        if (['super_admin', 'admin', 'moderator'].includes(sessionUser.role)) {
          setSwap({ kind: 'hidden' })
          return
        }
        // Swap kicks in on every page (not just Join-CTA pages) so vendors
        // see their "Mon restaurant" entry in the nav on /events,
        // /restaurant/[id], /order, etc.
        const vRes = await fetch('/api/vendor/restaurants', { cache: 'no-store' })
        const v = await vRes.json()
        if (cancelled) return
        const list: Array<{ status?: string }> = v.restaurants ?? []
        if (!list.length) { setSwap({ kind: 'join' }); return }
        const pending = list.every(r => r.status === 'pending')
        setSwap({ kind: 'myRestaurant', pending })
      } catch {
        if (!cancelled) { setSwap({ kind: 'join' }); setMe(null) }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Account pill label: first name when logged in, "Connexion / Login" otherwise.
  const accountLabel = me ? firstName(me.name) || me.name : 'Connexion / Login'

  return (
    <header className="sticky top-0 z-20 bg-surface/95 backdrop-blur-sm border-b border-divider">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-4">

        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 flex-shrink-0">
          <span className="bg-brand text-white font-black text-xs px-1.5 py-1 rounded-lg tracking-tight leading-none">NT</span>
          <span className="font-bold text-ink-primary text-base hidden sm:inline">Ndjoka &amp; Tchop</span>
        </Link>

        {/* Nav — underline-indicator pattern. No Dashboard link here; the
            single entry point for vendors is the "Mon restaurant" CTA on
            the right, which routes to /dashboard for approved owners. */}
        <nav className="flex items-center gap-1 sm:gap-2">
          <NavLink href="/" active={isRestaurants}>
            {t('nav.restaurants')}
          </NavLink>
          <NavLink href="/events" active={isEvents}>
            {t('nav.events')}
          </NavLink>
        </nav>

        {/* Right cluster */}
        <div className="flex items-center gap-2">
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
            className="text-ink-secondary hover:text-ink-primary hover:bg-surface-muted px-2.5 py-1.5 rounded-full text-sm font-semibold transition-colors flex items-center gap-1 max-w-[8rem] sm:max-w-[10rem]"
            title={me?.name ?? 'Connexion / Login'}
          >
            <span aria-hidden="true">👤</span>
            <span className="truncate">{accountLabel}</span>
          </Link>
          <LanguageToggle />

          {/* "Mon restaurant" vendor CTA — visible on every page (not
              gated by isJoinCta anymore) and on every viewport. On mobile
              it collapses to an icon-only pill so the 375px bar still
              fits everything; sm+ shows the full bilingual label. */}
          {swap.kind === 'myRestaurant' && (
            <Link
              href={swap.pending ? '/account' : '/dashboard'}
              className="flex items-center gap-1.5 bg-brand hover:bg-brand-dark text-white text-sm font-semibold px-3 sm:px-4 py-2 rounded-full transition-colors"
              title="Mon restaurant / My Restaurant"
            >
              <span>🏪</span>
              <span className="hidden sm:inline">Mon restaurant / My Restaurant</span>
              {swap.pending && (
                <span className="bg-white/25 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  <span className="sm:hidden">⏳</span>
                  <span className="hidden sm:inline">En attente / Pending</span>
                </span>
              )}
            </Link>
          )}

          {/* Incoming page CTA (e.g. "Join us" from the home page) — only
              shown when we haven't swapped it for the vendor CTA above. */}
          {cta && swap.kind !== 'myRestaurant' && swap.kind !== 'hidden' && (
            <Link
              href={cta.href}
              className="hidden sm:block bg-brand hover:bg-brand-dark text-white text-sm font-semibold px-4 py-2 rounded-full transition-colors"
            >
              {cta.label}
            </Link>
          )}
        </div>

      </div>
    </header>
  )
}

// Underline-indicator nav link (Uber Eats style, not filled pill).
function NavLink({
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
      className={`relative px-2 sm:px-3 py-4 text-sm font-semibold transition-colors ${
        active ? 'text-ink-primary' : 'text-ink-secondary hover:text-ink-primary'
      }`}
    >
      {children}
      {active && (
        <span className="absolute bottom-0 left-2 right-2 sm:left-3 sm:right-3 h-[2px] bg-ink-primary rounded-full" />
      )}
    </Link>
  )
}
