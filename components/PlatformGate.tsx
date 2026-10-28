'use client'

// Platform switches on the pages (M6). When Restaurants or Événements is
// switched off by an admin, its customer pages show "temporairement
// indisponible" instead of their content. Decided by the address, so no
// page has to remember it:
//   restaurants: /restaurants, /restaurant/…, /order, /pro/restaurants/new
//   events:      /events, /events/… (the organiser tools under /pro/events
//                stay open, so door checks can be finished)
// The home page hides the rows itself (/api/popular, /api/offers/today).
// The APIs refuse on their own (503 platform_off) — this is the screen.

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { useBi } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'

type Side = 'restaurants' | 'events'

function sideOf(path: string): Side | null {
  if (path === '/restaurants' || path.startsWith('/restaurant/') || path === '/order' || path.startsWith('/pro/restaurants/new')) return 'restaurants'
  if (path === '/events' || path.startsWith('/events/')) return 'events'
  return null
}

export default function PlatformGate({ children }: { children: React.ReactNode }) {
  const bi = useBi()
  const pathname = usePathname() ?? '/'
  const side = sideOf(pathname)
  const [status, setStatus] = useState<{ restaurants: boolean; events: boolean } | null>(null)

  useEffect(() => {
    if (!side) return
    let cancelled = false
    fetch('/api/platform/status', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setStatus(d) })
      .catch(() => null)
    return () => { cancelled = true }
  }, [side, pathname])

  // Unknown or on → the page as usual (the APIs still refuse if off).
  if (!side || !status || status[side]) return <>{children}</>

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-md mx-auto px-4 py-20 text-center">
        <p className="text-5xl mb-4" aria-hidden="true">⏸️</p>
        <h1 className="text-xl font-bold text-ink-primary mb-2">
          {side === 'restaurants'
            ? bi('Restaurants temporairement indisponibles', 'Restaurants temporarily unavailable')
            : bi('Événements temporairement indisponibles', 'Events temporarily unavailable')}
        </h1>
        <p className="text-sm text-ink-secondary mb-6">
          {bi('Nous revenons très vite. Merci de votre patience.', "We'll be back very soon. Thank you for your patience.")}
        </p>
        <Link href="/" className="inline-block bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-full font-semibold text-sm">
          {bi('Retour à l\'accueil', 'Back to home')}
        </Link>
      </main>
    </div>
  )
}
