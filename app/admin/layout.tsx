'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '@/lib/languageContext'
import LanguageToggle from '@/components/LanguageToggle'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  const router = useRouter()
  const pathname = usePathname()
  const { t } = useLanguage()

  const isLoginPage = pathname === '/admin'

  useEffect(() => {
    if (isLoginPage) {
      setChecking(false)
      return
    }
    const token = localStorage.getItem('adminToken')
    if (!token) {
      router.replace('/admin')
    } else {
      setAuthed(true)
    }
    setChecking(false)
  }, [isLoginPage, router])

  function logout() {
    localStorage.removeItem('adminToken')
    router.replace('/admin')
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center">
        <div className="text-orange-400 animate-pulse text-4xl">🍜</div>
      </div>
    )
  }

  if (isLoginPage) return <>{children}</>
  if (!authed) return null

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top nav */}
      <nav className="bg-white border-b border-gray-100 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2">
              <span className="bg-orange-500 text-white font-black text-xs px-1.5 py-1 rounded-lg tracking-tight leading-none">NT</span>
              <span className="font-bold text-gray-900 text-base hidden sm:inline">Ndjoka &amp; Tchop</span>
            </Link>
            <div className="flex items-center gap-1">
              <NavLink href="/admin/restaurants" active={pathname.startsWith('/admin/restaurants')}>
                {t('admin.navRest')}
              </NavLink>
              <NavLink href="/admin/orders" active={pathname.startsWith('/admin/orders')}>
                {t('admin.navOrders')}
              </NavLink>
              <NavLink href="/admin/events" active={pathname.startsWith('/admin/events')}>
                {t('admin.navEvents')}
              </NavLink>
              <NavLink href="/admin/vouchers" active={pathname.startsWith('/admin/vouchers')}>
                {t('admin.navVouchers')}
              </NavLink>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <LanguageToggle />
            <Link
              href="/admin/profile"
              className={`text-sm font-medium transition-colors px-3 py-1.5 rounded-lg ${
                pathname.startsWith('/admin/profile')
                  ? 'bg-orange-50 text-orange-600'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              👤 Mon profil / My Profile
            </Link>
            <button
              onClick={logout}
              className="text-sm text-gray-500 hover:text-gray-800 transition-colors px-3 py-1.5 rounded-lg hover:bg-gray-100"
            >
              {t('admin.logout')}
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {children}
      </main>
    </div>
  )
}

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
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
        active
          ? 'bg-orange-50 text-orange-600'
          : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
      }`}
    >
      {children}
    </Link>
  )
}
