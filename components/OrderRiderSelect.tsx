'use client'

// On a delivery order (dashboard, Q5, when riders use the app): pick the
// rider. The rider gets one WhatsApp with the order.

import { useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'

interface Rider { id: string; name: string }
const cache = new Map<string, Promise<Rider[]>>()

function ridersOf(restaurantId: string): Promise<Rider[]> {
  if (!cache.has(restaurantId)) {
    cache.set(restaurantId, fetch(`/api/restaurants/${restaurantId}/riders`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(d => (Array.isArray(d?.riders) ? d.riders : []) as Rider[]).catch(() => []))
  }
  return cache.get(restaurantId)!
}

export default function OrderRiderSelect({ orderId, restaurantId, riderId }: { orderId: string; restaurantId: string; riderId: string | null }) {
  const bi = useBi()
  const [riders, setRiders] = useState<Rider[]>([])
  const [value, setValue] = useState(riderId ?? '')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  useEffect(() => { void ridersOf(restaurantId).then(setRiders) }, [restaurantId])

  async function assign(next: string) {
    setValue(next); setState('saving')
    const r = await fetch(`/api/orders/${orderId}/rider`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rider_id: next || null }),
    }).catch(() => null)
    setState(r?.ok ? 'saved' : 'error')
  }

  if (riders.length === 0) return null
  return (
    <label className="mt-2 flex items-center gap-2 text-xs">
      <span className="text-ink-secondary">🛵 {bi('Livreur', 'Rider')}</span>
      <select value={value} onChange={e => assign(e.target.value)} disabled={state === 'saving'}
        className="flex-1 border border-divider rounded-lg px-2 py-1.5 text-sm bg-white">
        <option value="">{bi('— Non attribuée —', '— Not assigned —')}</option>
        {riders.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      {state === 'saved' && <span className="text-emerald-700">✓</span>}
      {state === 'error' && <span className="text-danger">✕</span>}
    </label>
  )
}
