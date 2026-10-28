'use client'

// Admin: the platform switch for one side (M6), at the top of Admin →
// Restaurants (Restaurants) and Admin → Événements (Événements). Turning a
// side off asks for confirmation and says what keeps working. Audited.

import { useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'

export default function AdminPlatformSwitch({ side }: { side: 'restaurants' | 'events' }) {
  const bi = useBi()
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/admin/platform', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setOn(d[side] !== false) })
      .catch(() => null)
  }, [side])

  const name = side === 'restaurants' ? bi('Restaurants', 'Restaurants') : bi('Événements', 'Events')

  async function flip() {
    if (on === null) return
    const next = !on
    if (!next && !confirm(bi(
      `Désactiver « ${name} » pour toute la plateforme ?\n\nLes clients verront « temporairement indisponible » ; commandes, réservations et inscriptions seront refusées (site et WhatsApp). Les paiements en cours se terminent, les pros gardent leurs outils.`,
      `Switch "${name}" off for the whole platform?\n\nCustomers will see "temporarily unavailable"; orders, bookings and sign-ups are refused (web and WhatsApp). Payments in flight still settle, pros keep their tools.`,
    ))) return
    setBusy(true)
    setError('')
    const res = await fetch('/api/admin/platform', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [side]: next }),
    })
    const d = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(d.error ?? bi('Erreur', 'Error')); return }
    setOn(d[side] !== false)
  }

  if (on === null) return null
  return (
    <div className={`rounded-2xl border px-4 py-3 mb-4 flex items-center justify-between gap-3 flex-wrap ${on ? 'bg-white border-divider' : 'bg-rose-50 border-rose-200'}`}>
      <span className="text-sm">
        <span className="font-bold text-ink-primary">{bi('Plateforme', 'Platform')} — {name} : </span>
        {on
          ? <span className="font-semibold text-emerald-700">{bi('activés', 'on')}</span>
          : <span className="font-semibold text-rose-700">{bi('désactivés (temporairement indisponibles)', 'off (temporarily unavailable)')}</span>}
        <span className="block text-xs text-ink-tertiary">{bi('Effectif en 30 secondes au plus.', 'Takes effect within 30 seconds.')}</span>
        {error && <span className="block text-xs text-danger">{error}</span>}
      </span>
      <button onClick={flip} disabled={busy}
        className={`text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-60 ${on ? 'bg-white border border-rose-200 text-rose-700 hover:bg-rose-50' : 'bg-emerald-600 hover:bg-emerald-700 text-white'}`}>
        {busy ? '…' : on ? bi('Désactiver', 'Switch off') : bi('Réactiver', 'Switch on')}
      </button>
    </div>
  )
}
