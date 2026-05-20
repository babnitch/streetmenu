'use client'

import { useState, useEffect, useCallback } from 'react'
import { useBi } from '@/lib/languageContext'

const CATEGORIES = [
  'Concert', 'Festival', 'BT/Club', 'Sport', 'Culture', 'Gastronomie', 'Enfants', 'Business', 'Autre',
] as const

function categoryLabel(cat: string): string {
  return cat === 'Enfants' ? '👶 Enfants' : cat
}

interface Sub {
  id: string
  city: string
  categories: string[] | null
  is_active: boolean
  created_at: string
  unsubscribed_at: string | null
}

// Notifications subsection inside the Profile tab. Lists every city the
// customer is subscribed to (active or unsubscribed), with per-row category
// toggles and an unsubscribe button. The "subscribe to a new city" path is
// the /events page button (lives next to the city dropdown).
export default function NotificationsPanel() {
  const bi = useBi()
  const [subs, setSubs] = useState<Sub[]>([])
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/subscriptions/my', { cache: 'no-store' })
      const d = await res.json()
      if (Array.isArray(d?.subscriptions)) setSubs(d.subscriptions)
    } catch { /* network — leave empty */ }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  async function patchCategories(sub: Sub, cat: string) {
    const have = sub.categories ?? [...CATEGORIES]
    const next = have.includes(cat) ? have.filter(c => c !== cat) : [...have, cat]
    if (next.length === 0) {
      flash(bi('Au moins une catégorie', 'At least one category'))
      return
    }
    setSavingId(sub.id)
    try {
      const isAll = next.length === CATEGORIES.length
      const res = await fetch(`/api/subscriptions/${sub.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: isAll ? null : next }),
      })
      if (!res.ok) throw new Error()
      setSubs(prev => prev.map(s => s.id === sub.id ? { ...s, categories: isAll ? null : next } : s))
    } catch {
      flash(bi('Erreur', 'Error'))
    } finally {
      setSavingId(null)
    }
  }

  async function unsubscribe(sub: Sub) {
    setSavingId(sub.id)
    try {
      const res = await fetch('/api/subscriptions/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: sub.city }),
      })
      if (!res.ok) throw new Error()
      flash(bi('🔕 Désabonné', '🔕 Unsubscribed'))
      await load()
    } catch {
      flash(bi('Erreur', 'Error'))
    } finally {
      setSavingId(null)
    }
  }

  async function reactivate(sub: Sub) {
    setSavingId(sub.id)
    try {
      const res = await fetch('/api/subscriptions/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: sub.city, categories: sub.categories }),
      })
      if (!res.ok) throw new Error()
      flash(bi('🔔 Abonné', '🔔 Subscribed'))
      await load()
    } catch {
      flash(bi('Erreur', 'Error'))
    } finally {
      setSavingId(null)
    }
  }

  if (loading) {
    return <p className="text-sm text-ink-tertiary">{bi('Chargement…', 'Loading…')}</p>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
          🔔 {bi('Notifications', 'Notifications')}
        </p>
        <a
          href="/events"
          className="text-xs font-semibold text-brand hover:text-brand-dark"
        >
          {bi('+ ville', '+ city')}
        </a>
      </div>

      {subs.length === 0 ? (
        <div className="bg-surface-muted rounded-xl p-3 text-sm text-ink-secondary">
          {bi(
            'Aucun abonnement. Abonnez-vous depuis la page Événements pour recevoir les nouveautés par WhatsApp.',
            'No subscriptions yet. Subscribe from the Events page to get new events via WhatsApp.',
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {subs.map(sub => {
            const active = sub.is_active
            const cats = sub.categories ?? [...CATEGORIES]
            return (
              <div key={sub.id} className={`border rounded-xl p-3 ${active ? 'border-brand-light bg-white' : 'border-divider bg-surface-muted/50'}`}>
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold text-ink-primary text-sm">
                    📍 {sub.city}
                  </p>
                  {active ? (
                    <button
                      onClick={() => unsubscribe(sub)}
                      disabled={savingId === sub.id}
                      className="text-xs font-semibold text-rose-600 hover:text-rose-700 disabled:opacity-50"
                    >
                      {bi('🔕 Se désabonner', '🔕 Unsubscribe')}
                    </button>
                  ) : (
                    <button
                      onClick={() => reactivate(sub)}
                      disabled={savingId === sub.id}
                      className="text-xs font-semibold text-brand hover:text-brand-dark disabled:opacity-50"
                    >
                      {bi('🔔 Réactiver', '🔔 Reactivate')}
                    </button>
                  )}
                </div>

                {active && (
                  <div className="flex flex-wrap gap-1.5">
                    {CATEGORIES.map(cat => {
                      const on = cats.includes(cat)
                      return (
                        <button
                          key={cat}
                          onClick={() => patchCategories(sub, cat)}
                          disabled={savingId === sub.id}
                          className={`text-xs font-semibold px-2.5 py-1 rounded-full transition-colors disabled:opacity-50 ${
                            on
                              ? 'bg-brand text-white'
                              : 'bg-surface-muted text-ink-tertiary hover:bg-divider'
                          }`}
                        >
                          {categoryLabel(cat)}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {toast && (
        <div className="mt-3 text-xs font-semibold text-ink-primary bg-surface-muted px-3 py-2 rounded-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
