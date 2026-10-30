'use client'

// "Mes favoris" in Mon compte (M7): the restaurants saved from the ⋯ menu of
// a restaurant page — photo, name, area; tap to open, ♥ to remove.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import SafeImage from '@/components/SafeImage'
import { useBi } from '@/lib/languageContext'

interface Fav {
  restaurant_id: string
  restaurant: { id: string; name: string; city: string; neighborhood: string | null; cuisine_type: string | null; image_url: string | null; logo_url: string | null } | null
}

export default function FavoritesList() {
  const bi = useBi()
  const [favs, setFavs] = useState<Fav[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/customer/favorites', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => setFavs(Array.isArray(d?.favorites) ? d.favorites.filter((f: Fav) => f.restaurant) : []))
      .catch(() => setFavs([]))
  }, [])

  async function remove(id: string) {
    setBusy(id)
    const res = await fetch(`/api/customer/favorites?restaurant_id=${id}`, { method: 'DELETE' })
    setBusy(null)
    if (res.ok) setFavs(prev => (prev ?? []).filter(f => f.restaurant_id !== id))
  }

  if (favs === null) return <div className="text-center py-12"><div className="text-3xl animate-pulse text-ink-tertiary">…</div></div>
  if (favs.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-4xl mb-3">♡</div>
        <p className="text-ink-tertiary text-sm">
          {bi('Aucun favori. Sur la page d\'un restaurant : ⋯ → Ajouter aux favoris.', 'No favourites yet. On a restaurant page: ⋯ → Add to favourites.')}
        </p>
      </div>
    )
  }
  return (
    <ul className="bg-white rounded-2xl shadow-sm divide-y divide-divider overflow-hidden">
      {favs.map(f => {
        const r = f.restaurant!
        const img = r.image_url || r.logo_url
        return (
          <li key={f.restaurant_id} className="flex items-center gap-3 px-4 py-3">
            <Link href={`/restaurant/${r.id}`} className="flex items-center gap-3 flex-1 min-w-0">
              <span className="relative w-14 h-14 rounded-xl overflow-hidden bg-brand-light flex-shrink-0">
                {img
                  ? <SafeImage src={img} alt="" fill sizes="56px" className="object-cover"
                      fallback={<span className="absolute inset-0 flex items-center justify-center text-2xl" aria-hidden="true">🍽️</span>} />
                  : <span className="absolute inset-0 flex items-center justify-center text-2xl" aria-hidden="true">🍽️</span>}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold text-ink-primary text-sm truncate">{r.name}</span>
                <span className="block text-xs text-ink-tertiary truncate">{[r.cuisine_type, r.neighborhood, r.city].filter(Boolean).join(' · ')}</span>
              </span>
            </Link>
            <button onClick={() => remove(r.id)} disabled={busy === r.id}
              aria-label={bi(`Retirer ${r.name} des favoris`, `Remove ${r.name} from favourites`)}
              className="w-9 h-9 rounded-full flex items-center justify-center text-brand text-lg hover:bg-brand-light disabled:opacity-50 flex-shrink-0">
              ♥
            </button>
          </li>
        )
      })}
    </ul>
  )
}
