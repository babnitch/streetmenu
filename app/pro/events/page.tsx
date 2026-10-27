'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import TopNav from '@/components/TopNav'
import { proLoginHref } from '@/lib/lastPhone'
import MyEventsPanel, { type MyEventsPanelEvent, type MyEventsPanelTrust } from '@/components/pro/MyEventsPanel'
import { useBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'

// /pro/events — "Mes événements": the organiser's events, bookings and
// settings. Moved here from /account (whose ?tab=events redirects here).
export default function ProEventsPage() {
  const bi = useBi()
  const { loading, canEnterPro, sessionRole, effectiveMode, setMode } = useMode()
  const [events, setEvents] = useState<MyEventsPanelEvent[] | null>(null)
  const [trust, setTrust] = useState<MyEventsPanelTrust | null>(null)

  useEffect(() => {
    if (canEnterPro && effectiveMode !== 'pro') setMode('pro')
  }, [canEnterPro, effectiveMode, setMode])

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/events/my', { cache: 'no-store' })
      const d = await r.json()
      setEvents(Array.isArray(d?.events) ? d.events : [])
      if (d?.trust) setTrust(d.trust as MyEventsPanelTrust)
    } catch {
      setEvents([])
    }
  }, [])

  useEffect(() => { if (canEnterPro) load() }, [canEnterPro, load])

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-2xl mx-auto px-4 py-6 pb-28 md:pb-10">
        {loading || (canEnterPro && events === null) ? (
          <div className="py-20 text-center text-4xl animate-bounce" aria-hidden="true">🎉</div>
        ) : !canEnterPro ? (
          <div className="bg-white rounded-2xl shadow-sm p-6 text-center">
            <h1 className="text-lg font-bold text-ink-primary mb-2">{bi('Mes événements', 'My events')}</h1>
            {sessionRole ? (
              <p className="text-sm text-ink-secondary">{bi('Réservé aux comptes clients.', 'For customer accounts only.')}</p>
            ) : (
              <Link href={proLoginHref('/pro/events')}
                className="inline-block bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm">
                🔐 {bi('Se connecter', 'Log in')}
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 mb-4">
              <h1 className="text-xl font-bold text-ink-primary">🎉 {bi('Mes événements', 'My events')}</h1>
              <Link href="/pro/profile" className="text-xs font-semibold text-brand hover:text-brand-dark underline underline-offset-2">
                {bi('Profil Pro', 'Pro profile')}
              </Link>
            </div>
            <MyEventsPanel events={events ?? []} trust={trust} onChanged={load} />
          </>
        )}
      </main>
    </div>
  )
}
