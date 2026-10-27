'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import TopNav from '@/components/TopNav'
import { proLoginHref } from '@/lib/lastPhone'
import { useBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'

// /pro — the Pro home. Open to every logged-in customer, with or without a
// restaurant: two big ways in (add a restaurant, create an event), plus
// shortcuts to what the user already runs. Visiting it puts the app in Pro
// mode, so the Pro navigation shows.
export default function ProHomePage() {
  const bi = useBi()
  const { loading, canEnterPro, sessionRole, effectiveMode, setMode, hasRestaurantRole } = useMode()
  const [eventCount, setEventCount] = useState<number | null>(null)
  const [restaurants, setRestaurants] = useState<Array<{ id: string; name: string; status?: string }>>([])

  useEffect(() => {
    if (canEnterPro && effectiveMode !== 'pro') setMode('pro')
  }, [canEnterPro, effectiveMode, setMode])

  useEffect(() => {
    if (!canEnterPro) return
    let cancelled = false
    ;(async () => {
      try {
        const [ev, rs] = await Promise.all([
          fetch('/api/events/my', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
          fetch('/api/vendor/restaurants', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
        ])
        if (cancelled) return
        setEventCount(Array.isArray(ev?.events) ? ev.events.length : 0)
        setRestaurants(Array.isArray(rs?.restaurants) ? rs.restaurants : [])
      } catch { /* shortcuts stay hidden */ }
    })()
    return () => { cancelled = true }
  }, [canEnterPro])

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-xl mx-auto px-4 py-6 pb-28 md:pb-10">
        {loading ? (
          <div className="py-20 text-center text-4xl animate-bounce" aria-hidden="true">🧰</div>
        ) : !canEnterPro ? (
          <div className="bg-white rounded-2xl shadow-sm p-6 text-center">
            <p className="text-3xl mb-3" aria-hidden="true">🧰</p>
            <h1 className="text-lg font-bold text-ink-primary mb-2">{bi('Espace Pro', 'Pro home')}</h1>
            {sessionRole ? (
              <p className="text-sm text-ink-secondary">
                {bi('Réservé aux comptes clients.', 'For customer accounts only.')}
              </p>
            ) : (
              <>
                <p className="text-sm text-ink-secondary mb-4">
                  {bi('Connectez-vous pour gérer vos restaurants et événements.', 'Log in to manage your restaurants and events.')}
                </p>
                <Link href={proLoginHref('/pro')}
                  className="inline-block bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm">
                  🔐 {bi('Se connecter', 'Log in')}
                </Link>
              </>
            )}
          </div>
        ) : (
          <>
            <h1 className="text-xl font-bold text-ink-primary">{bi('Espace Pro', 'Pro home')}</h1>
            <p className="text-sm text-ink-secondary mt-1 mb-5">
              {bi(
                'Recevez commandes et réservations sur WhatsApp, payées par Mobile Money.',
                'Get orders and bookings on WhatsApp, paid by Mobile Money.',
              )}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
              <Link href="/pro/restaurants/new"
                className="bg-white border-2 border-brand-light hover:border-brand rounded-2xl p-5 text-center shadow-sm transition-colors">
                <span className="block text-4xl mb-2" aria-hidden="true">🏪</span>
                <span className="block font-bold text-ink-primary">{bi('Ajouter un restaurant', 'Add a restaurant')}</span>
              </Link>
              <Link href="/events/submit"
                className="bg-white border-2 border-brand-light hover:border-brand rounded-2xl p-5 text-center shadow-sm transition-colors">
                <span className="block text-4xl mb-2" aria-hidden="true">🎉</span>
                <span className="block font-bold text-ink-primary">{bi('Créer un événement', 'Create an event')}</span>
              </Link>
            </div>

            <Link href="/pro/profile"
              className="flex items-center justify-between gap-3 bg-white rounded-2xl shadow-sm px-4 py-3 mb-3 hover:bg-brand-light transition-colors">
              <span className="text-sm font-semibold text-ink-primary">🪪 {bi('Profil Pro', 'Pro profile')}</span>
              <span className="text-xs text-ink-tertiary">{bi('Nom d\'organisateur, numéro de notifications', 'Organiser name, notification number')} ›</span>
            </Link>

            {(hasRestaurantRole || restaurants.length > 0 || (eventCount ?? 0) > 0) && (
              <div className="bg-white rounded-2xl shadow-sm divide-y divide-divider">
                {restaurants.map(r => (
                  <Link key={r.id} href={`/dashboard?restaurant=${r.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-brand-light transition-colors">
                    <span className="text-sm font-semibold text-ink-primary truncate">🏪 {r.name}</span>
                    {r.status === 'pending'
                      ? <span className="text-[11px] font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">{bi('En attente', 'Pending')}</span>
                      : <span className="text-ink-tertiary" aria-hidden="true">›</span>}
                  </Link>
                ))}
                {(eventCount ?? 0) > 0 && (
                  <Link href="/pro/events"
                    className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-brand-light transition-colors">
                    <span className="text-sm font-semibold text-ink-primary">🎉 {bi('Mes événements', 'My events')} ({eventCount})</span>
                    <span className="text-ink-tertiary" aria-hidden="true">›</span>
                  </Link>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
