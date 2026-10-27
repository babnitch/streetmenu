'use client'

// "🔔 S'abonner" for the Events page: get the city's new events on WhatsApp
// (event_subscriptions). The button, its modal and its toast — moved as is
// from the old events page (E2).

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useCity } from '@/lib/cityContext'
import { categoryLabel } from '@/lib/categoryLabels'
import { loginHref } from '@/lib/lastPhone'

export const EVENT_CATEGORIES = [
  'Concert', 'Festival', 'BT/Club', 'Sport', 'Culture', 'Gastronomie', 'Enfants', 'Business', 'Autre',
]
const CATEGORIES = EVENT_CATEGORIES

interface MySubscription {
  id: string
  city: string
  categories: string[] | null
  is_active: boolean
}

export default function SubscribeButton({ className = '' }: { className?: string }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const { city } = useCity()
  const router = useRouter()

  // Subscription state
  const [mySubs, setMySubs] = useState<MySubscription[]>([])
  const [subModalOpen, setSubModalOpen] = useState(false)
  const [subCategories, setSubCategories] = useState<Set<string>>(new Set(CATEGORIES))
  const [subSaving, setSubSaving] = useState(false)
  const [subToast, setSubToast] = useState<string | null>(null)

  const currentSub = mySubs.find(s => s.city === city && s.is_active)

  const loadSubscriptions = useCallback(async () => {
    try {
      const res = await fetch('/api/subscriptions/my', { cache: 'no-store' })
      const d = await res.json()
      if (Array.isArray(d?.subscriptions)) setMySubs(d.subscriptions)
    } catch { /* anon user — empty */ }
  }, [])

  useEffect(() => { loadSubscriptions() }, [loadSubscriptions])

  function openSubModal() {
    if (currentSub) {
      setSubCategories(new Set(currentSub.categories ?? CATEGORIES))
    } else {
      setSubCategories(new Set(CATEGORIES))
    }
    setSubModalOpen(true)
  }

  function toggleSubCategory(cat: string) {
    setSubCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  async function saveSubscription() {
    setSubSaving(true)
    try {
      const isAll = subCategories.size === CATEGORIES.length
      const res = await fetch('/api/subscriptions/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city,
          categories: isAll ? null : Array.from(subCategories),
        }),
      })
      const d = await res.json()
      if (!res.ok) {
        if (res.status === 401) {
          setSubToast(bi('Connectez-vous pour vous abonner', 'Log in to subscribe'))
          setSubModalOpen(false)
          setTimeout(() => router.push(loginHref('/events')), 1200)
          return
        }
        throw new Error(d?.error ?? 'Error')
      }
      setSubToast(bi(
        '🔔 Vous recevrez les nouveaux événements par WhatsApp!',
        '🔔 You\'ll receive new events via WhatsApp!',
      ))
      setSubModalOpen(false)
      await loadSubscriptions()
    } catch (e) {
      setSubToast((e as Error).message)
    } finally {
      setSubSaving(false)
      setTimeout(() => setSubToast(null), 3500)
    }
  }

  async function unsubscribeFromCity() {
    if (!currentSub) return
    setSubSaving(true)
    try {
      const res = await fetch('/api/subscriptions/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error ?? 'Error')
      }
      setSubToast(bi('🔕 Désabonné', '🔕 Unsubscribed'))
      setSubModalOpen(false)
      await loadSubscriptions()
    } catch (e) {
      setSubToast((e as Error).message)
    } finally {
      setSubSaving(false)
      setTimeout(() => setSubToast(null), 3500)
    }
  }

  return (
    <>
      <button
        onClick={openSubModal}
        className={`text-xs font-semibold px-3 py-2 rounded-xl transition-colors whitespace-nowrap ${
          currentSub ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-brand text-white hover:bg-brand-dark'
        } ${className}`}
      >
        {currentSub
          ? bi('🔕 Gérer mon abonnement', '🔕 Manage subscription')
          : bi('🔔 Recevoir les nouveaux événements', '🔔 Get new events')}
      </button>

      {/* Subscription modal */}
      {subModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/40" onClick={() => setSubModalOpen(false)}>
          <div className="bg-white rounded-2xl shadow-card max-w-md w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-5">
              <h3 className="text-lg font-bold text-ink-primary mb-1">
                {currentSub
                  ? bi('🔕 Gérer mon abonnement', '🔕 Manage subscription')
                  : bi('🔔 S\'abonner aux notifications', '🔔 Subscribe to notifications')}
              </h3>
              <p className="text-sm text-ink-tertiary mb-4">
                {bi(
                  `Recevez les nouveaux événements à ${city} par WhatsApp.`,
                  `Get new events in ${city} on WhatsApp.`,
                )}
              </p>

              <div className="mb-4">
                <div className="text-xs font-semibold text-ink-secondary mb-2">
                  {bi('Ville', 'City')}
                </div>
                <div className="bg-surface-muted px-3 py-2 rounded-xl text-sm text-ink-primary">
                  📍 {city}
                </div>
              </div>

              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-semibold text-ink-secondary">
                    {bi('Catégories', 'Categories')}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSubCategories(prev =>
                      prev.size === CATEGORIES.length ? new Set() : new Set(CATEGORIES),
                    )}
                    className="text-xs font-semibold text-brand hover:text-brand-dark"
                  >
                    {subCategories.size === CATEGORIES.length
                      ? bi('Tout désélectionner', 'Deselect all')
                      : bi('Tout sélectionner', 'Select all')}
                  </button>
                </div>
                <div className="space-y-1.5">
                  {CATEGORIES.map(cat => (
                    <label key={cat} className="flex items-center gap-2 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={subCategories.has(cat)}
                        onChange={() => toggleSubCategory(cat)}
                        className="w-4 h-4 rounded border-divider text-brand"
                      />
                      <span className="text-ink-primary">{categoryLabel(cat, locale)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  onClick={saveSubscription}
                  disabled={subSaving || subCategories.size === 0}
                  className="w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
                >
                  {subSaving
                    ? '…'
                    : currentSub
                      ? bi('💾 Mettre à jour', '💾 Update')
                      : bi('✅ S\'abonner', '✅ Subscribe')}
                </button>
                {currentSub && (
                  <button
                    onClick={unsubscribeFromCity}
                    disabled={subSaving}
                    className="w-full bg-rose-50 hover:bg-rose-100 disabled:opacity-50 text-rose-600 font-semibold py-2.5 rounded-xl text-sm transition-colors"
                  >
                    {bi('🔕 Se désabonner', '🔕 Unsubscribe')}
                  </button>
                )}
                <button
                  onClick={() => setSubModalOpen(false)}
                  className="w-full text-ink-tertiary hover:text-ink-primary font-medium py-2 text-sm transition-colors"
                >
                  {bi('Annuler', 'Cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {subToast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] bg-ink-primary text-white text-sm font-semibold px-4 py-2.5 rounded-full shadow-card max-w-[90vw] text-center">
          {subToast}
        </div>
      )}

    </>
  )
}
