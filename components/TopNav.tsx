'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useCart } from '@/lib/cartContext'
import { useLanguage } from '@/lib/languageContext'
import { useAuth } from '@/lib/authContext'
import LanguageToggle from './LanguageToggle'

interface TopNavProps {
  cta?: { label: string; href: string }
}

// When the page hands us the "+ Join Us" CTA, we may need to swap it:
//   - logged-out users or customers with no restaurant → keep it
//   - customers with ≥1 restaurant → "Mon restaurant / My Restaurant" → /account,
//     with a Pending pill if every linked restaurant is still pending
//   - admins / moderators → hide entirely (they have their own dashboard)
type JoinSwap =
  | { kind: 'join' }                                    // show incoming CTA unchanged
  | { kind: 'myRestaurant'; pending: boolean }          // customer owns at least one
  | { kind: 'hidden' }                                  // admin role or still resolving

export default function TopNav({ cta }: TopNavProps = {}) {
  const pathname = usePathname()
  const { totalItems } = useCart()
  const { t } = useLanguage()
  const { user } = useAuth()

  const isRestaurants = pathname === '/' || pathname.startsWith('/restaurant')
  const isEvents      = pathname.startsWith('/events')

  const isJoinCta = cta?.href === '/join'
  const [swap, setSwap] = useState<JoinSwap>({ kind: 'join' })
  // Separate from swap: whether to show the persistent Dashboard pill in
  // the nav. True when the session owns/manages ≥1 non-pending restaurant,
  // regardless of whether the page passes a Join CTA.
  const [showDashboard, setShowDashboard] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const meRes = await fetch('/api/auth/me', { cache: 'no-store' })
        const me = await meRes.json()
        if (cancelled) return
        if (!me.user) { setSwap({ kind: 'join' }); setShowDashboard(false); return }
        if (['super_admin', 'admin', 'moderator'].includes(me.user.role)) {
          setSwap({ kind: 'hidden' })
          setShowDashboard(false)
          return
        }
        const vRes = await fetch('/api/vendor/restaurants', { cache: 'no-store' })
        const v = await vRes.json()
        if (cancelled) return
        const list: Array<{ status?: string }> = v.restaurants ?? []
        if (!list.length) { setSwap({ kind: 'join' }); setShowDashboard(false); return }
        const pending = list.every(r => r.status === 'pending')
        if (isJoinCta) setSwap({ kind: 'myRestaurant', pending })
        // Dashboard is only useful once ≥1 restaurant is actually approved.
        setShowDashboard(!pending)
      } catch {
        if (!cancelled) { setSwap({ kind: 'join' }); setShowDashboard(false) }
      }
    })()
    return () => { cancelled = true }
  }, [isJoinCta])

  return (
    <header className="sticky top-0 z-20 bg-white/95 backdrop-blur-sm border-b border-orange-100 shadow-sm">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-3">

        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 flex-shrink-0">
          <span className="bg-orange-500 text-white font-black text-xs px-1.5 py-1 rounded-lg tracking-tight leading-none">NT</span>
          <span className="font-bold text-gray-900 text-base hidden sm:inline">Ndjoka &amp; Tchop</span>
        </Link>

        {/* Nav pills */}
        <nav className="flex items-center gap-1">
          <NavPill href="/" active={isRestaurants}>
            {t('nav.restaurants')}
          </NavPill>
          <NavPill href="/events" active={isEvents}>
            {t('nav.events')}
          </NavPill>
          {showDashboard && (
            <NavPill href="/dashboard" active={pathname?.startsWith('/dashboard') ?? false}>
              📦 Dashboard
            </NavPill>
          )}
        </nav>

        {/* Right cluster */}
        <div className="flex items-center gap-2">
          {totalItems > 0 && (
            <Link
              href="/order"
              className="bg-orange-500 text-white rounded-xl px-3 py-1.5 text-sm font-semibold flex items-center gap-1.5 hover:bg-orange-600 transition-colors"
            >
              🛒 {totalItems}
            </Link>
          )}
          <Link
            href="/account"
            className="text-gray-600 hover:text-gray-900 hover:bg-gray-50 px-3 py-1.5 rounded-xl text-sm font-semibold transition-colors flex items-center gap-1"
            title={t('nav.account')}
          >
            {user ? '👤' : <span className="hidden sm:inline">{t('nav.account')}</span>}
            {!user && <span className="sm:hidden">👤</span>}
          </Link>
          <LanguageToggle />
          {cta && isJoinCta && swap.kind === 'myRestaurant' && (
            <Link
              href={swap.pending ? '/account' : '/dashboard'}
              className="hidden sm:flex items-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-1.5 rounded-xl transition-colors"
            >
              🏪 Mon restaurant / My Restaurant
              {swap.pending && (
                <span className="bg-white/25 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  En attente / Pending
                </span>
              )}
            </Link>
          )}
          {cta && (!isJoinCta || swap.kind === 'join') && (
            <Link
              href={cta.href}
              className="hidden sm:block bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-1.5 rounded-xl transition-colors"
            >
              {cta.label}
            </Link>
          )}
          {/* swap.kind === 'hidden' renders nothing */}
        </div>

      </div>
    </header>
  )
}

function NavPill({
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
      className={`px-3 py-1.5 rounded-xl text-sm font-semibold transition-colors ${
        active
          ? 'bg-orange-500 text-white shadow-sm'
          : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
      }`}
    >
      {children}
    </Link>
  )
}
