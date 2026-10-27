'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { useLanguage, useBi } from '@/lib/languageContext'
import LanguageToggle from '@/components/LanguageToggle'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const bi = useBi()
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  const pathname = usePathname()
  const { t } = useLanguage()

  // /admin/login renders on its own. Every other /admin page needs the
  // real admin login (the session cookie the admin APIs check); the old
  // password + browser token is gone. Logged out → /admin/login, which
  // brings the visitor back here.
  const isLoginPage = pathname === '/admin/login'

  useEffect(() => {
    if (isLoginPage) {
      setChecking(false)
      return
    }
    let cancelled = false
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d?.user && ['super_admin', 'admin', 'moderator'].includes(d.user.role)) {
          // /admin itself has no page of its own: the console is /account.
          if (pathname === '/admin') { window.location.replace('/account'); return }
          setAuthed(true)
          setChecking(false)
        } else {
          const back = pathname === '/admin' ? '' : `?return=${encodeURIComponent(pathname)}`
          window.location.replace(`/admin/login${back}`)
        }
      })
      .catch(() => { if (!cancelled) window.location.replace('/admin/login') })
    return () => { cancelled = true }
  }, [isLoginPage, pathname])

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }) } catch {}
    window.location.href = '/admin/login'
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-brand animate-pulse text-4xl">🍜</div>
      </div>
    )
  }

  if (isLoginPage) return <>{children}</>
  if (!authed) return null

  return (
    <div className="min-h-screen bg-surface-muted">
      {/* Top nav */}
      <nav className="bg-white border-b border-divider sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2">
              <span className="bg-brand text-white font-black text-xs px-1.5 py-1 rounded-lg tracking-tight leading-none">TN</span>
              <span className="font-bold text-ink-primary text-base hidden sm:inline">Tchop &amp; Ndjoka</span>
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
                  ? 'bg-brand-light text-brand-dark'
                  : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-muted'
              }`}
            >
              👤 {bi('Mon profil', 'My Profile')}
            </Link>
            <button
              onClick={logout}
              className="text-sm text-ink-secondary hover:text-ink-primary transition-colors px-3 py-1.5 rounded-lg hover:bg-surface-muted"
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
          ? 'bg-brand-light text-brand-dark'
          : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-muted'
      }`}
    >
      {children}
    </Link>
  )
}
