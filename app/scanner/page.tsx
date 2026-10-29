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

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const ev = q.get('event'), rest = q.get('restaurant')
    if (ev) {
      setScope({ eventId: ev })
      fetch(`/api/events/${ev}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
        .then(d => setTitle(d?.event?.title ?? d?.title ?? '')).catch(() => null)
    } else if (rest) setScope({ restaurantId: rest })
  }, [])

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-md mx-auto px-4 pt-5 pb-28">
        {title && <h1 className="text-xl font-black text-ink-primary mb-3">🎟 {title}</h1>}
        {scope ? <ValidatePanel scope={scope} /> : (
          <p className="text-center text-ink-tertiary mt-10">
            {bi('Choisissez un événement à contrôler.', 'Pick an event to check.')}{' '}
            <Link href="/account" className="underline">{bi('Mon compte', 'My account')}</Link>
          </p>
        )}
      </main>
    </div>
  )
}
