'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCart } from '@/lib/cartContext'
import { useLanguage } from '@/lib/languageContext'
import { useAuth } from '@/lib/authContext'
import LanguageToggle from './LanguageToggle'

interface TopNavProps {
  cta?: { label: string; href: string }
}

export default function TopNav({ cta }: TopNavProps = {}) {
  const pathname = usePathname()
  const { totalItems } = useCart()
  const { t } = useLanguage()
  const { user } = useAuth()

  const isRestaurants = pathname === '/' || pathname.startsWith('/restaurant')
  const isEvents      = pathname.startsWith('/events')

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
          {cta && (
            <Link
              href={cta.href}
              className="hidden sm:block bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-1.5 rounded-xl transition-colors"
            >
              {cta.label}
            </Link>
          )}
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
