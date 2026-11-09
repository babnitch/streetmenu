'use client'

// Admin → Restaurants: « ✏️ Modifié par le propriétaire » — owners' changes to
// name, address, pin, city, area or phones. Already live (no new approval);
// the admin checks and taps « Vu ». Hidden when there is nothing to see.

import { useCallback, useEffect, useState } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { DETAIL_LABELS, type DetailField } from '@/lib/restaurantDetailFields'

interface Notice {
  id: string; restaurant_id: string; created_at: string
  changes: Record<string, { old: unknown; new: unknown }>
  restaurants: { name: string; city: string } | null
}

const show = (v: unknown) => (v == null || v === '' ? '—' : String(v))

export default function AdminRestaurantNotices() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [notices, setNotices] = useState<Notice[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/restaurant-notices', { cache: 'no-store' })
      const d = await r.json().catch(() => ({}))
      if (Array.isArray(d?.notices)) setNotices(d.notices as Notice[])
    } catch { /* keep */ }
  }, [])
  useEffect(() => { void load() }, [load])

  async function seen(id: string) {
    setBusy(id)
    try {
      const r = await fetch(`/api/admin/restaurant-notices/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'seen' }) })
      if (r.ok) setNotices(prev => prev.filter(n => n.id !== id))
    } finally { setBusy(null) }
  }

  if (!notices.length) return null
  return (
    <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <p className="font-bold text-amber-900 text-sm mb-2">✏️ {bi('Modifié par le propriétaire', 'Changed by the owner')} ({notices.length})</p>
      <p className="text-xs text-amber-800 mb-3">{bi('Déjà en ligne, sans nouvelle approbation. Vérifiez puis « Vu ».', 'Already live, no new approval. Check, then « Seen ».')}</p>
      <div className="space-y-2">
        {notices.map(n => {
          const fields = Object.keys(n.changes) as DetailField[]
          const pin = fields.includes('lat') || fields.includes('lng')
          return (
            <div key={n.id} className="bg-white rounded-xl p-3 text-sm flex items-start justify-between gap-3">
              <div className="min-w-0">
                <a href={`/restaurant/${n.restaurant_id}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-ink-primary underline">
                  {n.restaurants?.name ?? bi('Restaurant', 'Restaurant')}
                </a>
                <span className="text-xs text-ink-tertiary"> · {new Date(n.created_at).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span>
                <ul className="mt-1 space-y-0.5 text-xs text-ink-secondary">
                  {fields.filter(f => f !== 'lat' && f !== 'lng').map(f => (
                    <li key={f}><span className="font-semibold">{bi(DETAIL_LABELS[f]?.fr ?? f, DETAIL_LABELS[f]?.en ?? f)}</span> : {show(n.changes[f].old)} → <span className="text-ink-primary">{show(n.changes[f].new)}</span></li>
                  ))}
                  {pin && <li><span className="font-semibold">{bi('Position sur la carte', 'Map pin')}</span> : {bi('déplacée', 'moved')}</li>}
                </ul>
              </div>
              <button type="button" disabled={busy === n.id} onClick={() => void seen(n.id)}
                className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full border border-amber-300 bg-white text-amber-900 disabled:opacity-50">
                {busy === n.id ? '…' : bi('✓ Vu', '✓ Seen')}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
