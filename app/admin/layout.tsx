'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  const router = useRouter()
  const pathname = usePathname()

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
            <Link href="/" className="text-orange-500 font-bold text-lg tracking-tight">
              🍜 StreetMenu
            </Link>
            <div className="flex items-center gap-1">
              <NavLink href="/admin/restaurants" active={pathname.startsWith('/admin/restaurants')}>
                Restaurants
              </NavLink>
              <NavLink href="/admin/orders" active={pathname.startsWith('/admin/orders')}>
                Orders
              </NavLink>
            </div>
          </div>
          <button
            onClick={logout}
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors px-3 py-1.5 rounded-lg hover:bg-gray-100"
          >
            Log out
          </button>
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
