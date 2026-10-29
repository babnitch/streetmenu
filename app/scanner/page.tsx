'use client'

// /scanner?event=<id> or ?restaurant=<id> (Q3) — the check-in / hand-over
// screen for one event or restaurant: the in-app scanner and the typed code.
// Used by organisers (Mes événements → Contrôler les billets) and door staff
// (☰ → Contrôler des billets). The server decides who may validate.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import TopNav from '@/components/TopNav'
import ValidatePanel, { type ValidateScope } from '@/components/ValidatePanel'
import { useBi } from '@/lib/languageContext'

export default function ScannerPage() {
  const bi = useBi()
  const [scope, setScope] = useState<ValidateScope | null>(null)
  const [title, setTitle] = useState('')
  // No event in the link: the events this person checks tickets for (Q4).
  const [mine, setMine] = useState<Array<{ id: string; title: string; venue: string | null; date: string; role: string }> | null>(null)

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const ev = q.get('event'), rest = q.get('restaurant')
    if (ev) {
      setScope({ eventId: ev })
      fetch(`/api/events/${ev}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
        .then(d => setTitle(d?.event?.title ?? d?.title ?? '')).catch(() => null)
    } else if (rest) setScope({ restaurantId: rest })
    else fetch('/api/scan/my-events', { cache: 'no-store' }).then(r => r.json()).then(d => setMine(d?.events ?? [])).catch(() => setMine([]))
  }, [])

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-md mx-auto px-4 pt-5 pb-28">
        {title && <h1 className="text-xl font-black text-ink-primary mb-3">🎟 {title}</h1>}
        {scope ? <ValidatePanel scope={scope} /> : (
          <>
            <h1 className="text-xl font-black text-ink-primary mb-3">🚪 {bi('Contrôler des billets', 'Check tickets')}</h1>
            {mine === null ? <p className="text-ink-tertiary">…</p> : mine.length === 0 ? (
              <p className="text-ink-tertiary text-sm">
                {bi('Aucun événement à contrôler. L\'organisateur doit vous ajouter au contrôle.', 'No event to check. The organiser has to add you to the door.')}{' '}
                <Link href="/account" className="underline">{bi('Mon compte', 'My account')}</Link>
              </p>
            ) : (
              <ul className="space-y-2">
                {mine.map(e => (
                  <li key={e.id}>
                    <a href={`/scanner?event=${e.id}`} className="block bg-white rounded-2xl shadow-sm p-4 hover:shadow-md">
                      <span className="block font-semibold text-ink-primary">{e.title}</span>
                      <span className="block text-xs text-ink-tertiary">{[e.venue, e.date].filter(Boolean).join(' · ')}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  )
}
