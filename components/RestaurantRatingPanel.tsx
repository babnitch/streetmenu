'use client'

// Aggregate display + rate-this-restaurant modal on /restaurant/[id].
//
// The panel is intentionally self-contained: it owns the GET + POST round
// trips, the modal state, and the URL-hash trigger that opens the modal
// when a customer follows the post-delivery WhatsApp link. The parent page
// just renders <RestaurantRatingPanel restaurantId={id} /> below the menu.

import { useEffect, useState, useCallback } from 'react'
import { useLanguage, useBi } from '@/lib/languageContext'
// tagsForRating exists in @/lib/ratings but isn't used here — the
// component selects the tag set inline based on the chosen star count
// (rating === 3 needs both sets shown, which the helper doesn't model).
import { POSITIVE_TAGS, NEGATIVE_TAGS, ALL_TAGS } from '@/lib/ratings'

interface Aggregate {
  average:      number
  count:        number
  distribution: Record<1 | 2 | 3 | 4 | 5, number>
  top_tags:     Array<{ id: string; count: number }>
  can_rate:     boolean
  their_rating: { rating: number; tags: string[]; order_id: string } | null
}

export default function RestaurantRatingPanel({ restaurantId }: { restaurantId: string }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [agg, setAgg] = useState<Aggregate | null>(null)
  const [loading, setLoading] = useState(true)

  // Modal state. selectedStars=0 means "no rating chosen yet" — the submit
  // button stays disabled.
  const [showModal, setShowModal] = useState(false)
  const [selectedStars, setSelectedStars] = useState(0)
  const [selectedTags, setSelectedTags]   = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [fetchError, setFetchError] = useState('')

  const fetchAgg = useCallback(async () => {
    setLoading(true)
    setFetchError('')
    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/rating`, { cache: 'no-store' })
      const data = await res.json()
      console.log('[rating-panel] fetch', { restaurantId, status: res.status, data })
      if (!res.ok) {
        // Most common cause: supabase-reviews.sql hasn't been applied
        // and the API 500s on the missing table. Keep the panel visible
        // so the user knows the section exists, just with a hint.
        setFetchError(data?.error ?? `HTTP ${res.status}`)
        setAgg(null)
        return
      }
      setAgg(data as Aggregate)
    } catch (e) {
      console.error('[rating-panel] fetch threw:', (e as Error).message)
      setFetchError((e as Error).message)
      setAgg(null)
    } finally {
      setLoading(false)
    }
  }, [restaurantId])

  useEffect(() => { fetchAgg() }, [fetchAgg])

  // Auto-open the modal when the customer lands via /restaurant/[id]#rate
  // (the WhatsApp post-delivery prompt deep-links here). Only fires once
  // per mount and only after the aggregate has loaded — we need can_rate
  // to know whether to open at all.
  useEffect(() => {
    if (!agg || !agg.can_rate) return
    if (typeof window === 'undefined') return
    if (window.location.hash !== '#rate') return
    openRateModal()
    // Strip the hash so a refresh doesn't re-trigger.
    history.replaceState(null, '', window.location.pathname + window.location.search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agg])

  function openRateModal() {
    if (!agg?.can_rate) return
    setSelectedStars(agg.their_rating?.rating ?? 0)
    setSelectedTags(agg.their_rating?.tags ?? [])
    setError('')
    setShowModal(true)
  }

  function toggleTag(id: string) {
    setSelectedTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id])
  }

  async function submit() {
    if (selectedStars < 1) return
    setSubmitting(true); setError('')
    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: selectedStars, tags: selectedTags }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? bi('Erreur', 'Error')); return }
      setShowModal(false)
      await fetchAgg()
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    // Render the section header during the initial fetch so the card has
    // visible presence on mobile (previous "…" centered text was easy to
    // miss between the hero and the menu).
    return (
      <div className="bg-white rounded-2xl shadow-sm p-4">
        <h2 className="text-base font-bold text-ink-primary mb-2">
          ⭐ {bi('Avis', 'Ratings')}
        </h2>
        <p className="text-xs text-ink-tertiary">…</p>
      </div>
    )
  }
  // Don't vanish silently on fetch errors. Common cause is the
  // restaurant_ratings table not yet existing on the live DB (the
  // supabase-reviews.sql migration hasn't been run). Render the
  // section header + a hint so the surface is still discoverable.
  if (!agg) {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-4">
        <h2 className="text-base font-bold text-ink-primary mb-2">
          ⭐ {bi('Avis', 'Ratings')}
        </h2>
        <p className="text-xs text-ink-tertiary">
          {bi(
            'Les avis seront bientôt disponibles.',
            'Ratings will be available soon.',
          )}
        </p>
        {fetchError && (
          <p className="text-[10px] text-ink-tertiary mt-1 font-mono">debug: {fetchError}</p>
        )}
      </div>
    )
  }

  // Filter out tags from the visible chip set if their count is 0 — keeps
  // the "Top tags" line readable when only a couple of customers have rated.
  const TAG_SET = (selectedStars >= 4 || selectedStars === 0) ? POSITIVE_TAGS : NEGATIVE_TAGS
  const showAllTagsInModal = selectedStars === 3  // boundary — show both sets

  return (
    <>
      <div className="bg-white rounded-2xl shadow-sm p-4">
        <h2 className="text-base font-bold text-ink-primary mb-3">
          ⭐ {bi('Avis', 'Ratings')}
        </h2>

        {agg.count === 0 ? (
          <p className="text-sm text-ink-tertiary mb-3">
            {bi(
              'Pas encore d\'avis. Soyez le premier à noter après votre commande.',
              'No ratings yet. Be the first to rate after your order.',
            )}
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-3">
              <p className="text-3xl font-black text-ink-primary leading-none">
                {agg.average.toFixed(1)}
              </p>
              <div>
                <StarRow value={agg.average} />
                <p className="text-xs text-ink-tertiary mt-0.5">
                  {agg.count} {bi('avis', 'ratings')}
                </p>
              </div>
            </div>

            {/* Distribution. Each row is a fill bar relative to the modal
                count — denominator is the total count so all rows sum to
                100%. */}
            <div className="space-y-1 mb-3">
              {([5, 4, 3, 2, 1] as const).map(n => {
                const c = agg.distribution[n]
                const pct = agg.count > 0 ? Math.round((c / agg.count) * 100) : 0
                return (
                  <div key={n} className="flex items-center gap-2 text-xs text-ink-secondary">
                    <span className="w-3 text-right font-mono">{n}</span>
                    <span>⭐</span>
                    <div className="flex-1 h-2 bg-surface-muted rounded-full overflow-hidden">
                      <div className="h-full bg-amber-400" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-12 text-right font-mono text-ink-tertiary">{pct}%</span>
                  </div>
                )
              })}
            </div>

            {agg.top_tags.length > 0 && (
              <p className="text-xs text-ink-secondary leading-relaxed">
                {agg.top_tags.map(({ id, count }) => {
                  const t = ALL_TAGS[id]
                  if (!t) return null
                  const label = locale === 'fr' ? t.fr : t.en
                  return `${t.emoji} ${label} (${count})`
                }).filter(Boolean).join(' · ')}
              </p>
            )}
          </>
        )}

        {/* CTA. agg.can_rate is true when the customer has at least one
            delivered order here. their_rating populated means they already
            rated — flip the copy to "Modify". */}
        <div className="mt-4 pt-3 border-t border-divider">
          {agg.can_rate ? (
            <button
              onClick={openRateModal}
              className="w-full bg-brand hover:bg-brand-dark text-white py-2.5 rounded-full text-sm font-semibold transition-colors"
            >
              ⭐ {agg.their_rating
                ? bi('Modifier ma note', 'Edit my rating')
                : bi('Donner une note', 'Rate this restaurant')}
            </button>
          ) : (
            <p className="text-xs text-ink-tertiary text-center">
              {bi('Commandez pour pouvoir noter.', 'Order to be able to rate.')}
            </p>
          )}
        </div>
      </div>

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => !submitting && setShowModal(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-ink-primary mb-1">
              ⭐ {bi('Votre note', 'Your rating')}
            </h3>
            <p className="text-xs text-ink-tertiary mb-4">
              {bi(
                'Anonyme — seul le score moyen est public.',
                'Anonymous — only the average score is public.',
              )}
            </p>

            {/* Star picker — large taps, hover-emphasis subtle on touch. */}
            <div className="flex items-center justify-center gap-1 mb-4">
              {[1, 2, 3, 4, 5].map(n => (
                <button
                  key={n}
                  onClick={() => { setSelectedStars(n); /* keep tags chosen so far */ }}
                  className="text-3xl leading-none transition-transform active:scale-95"
                  aria-label={`${n} ${bi('étoiles', 'stars')}`}
                >
                  {selectedStars >= n ? '⭐' : '☆'}
                </button>
              ))}
            </div>

            {/* Tag picker — gated on a chosen rating so the user picks the
                star first, then the relevant tag set appears. Rating=3
                shows both sets per spec. */}
            {selectedStars > 0 && (
              <div className="mb-4">
                <p className="text-xs text-ink-secondary mb-2">
                  {bi('Précisez (optionnel):', 'Add details (optional):')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(showAllTagsInModal ? [...POSITIVE_TAGS, ...NEGATIVE_TAGS] : TAG_SET).map(t => {
                    const active = selectedTags.includes(t.id)
                    const label = locale === 'fr' ? t.fr : t.en
                    return (
                      <button
                        key={t.id}
                        onClick={() => toggleTag(t.id)}
                        className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-colors ${
                          active
                            ? 'bg-brand text-white border-brand'
                            : 'bg-surface-muted text-ink-secondary border-divider hover:bg-divider'
                        }`}
                      >
                        {t.emoji} {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {error && <p className="text-xs text-danger mb-3">{error}</p>}

            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowModal(false)}
                disabled={submitting}
                className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-surface-muted text-ink-secondary hover:bg-divider transition-colors disabled:opacity-50"
              >
                {bi('Annuler', 'Cancel')}
              </button>
              <button
                onClick={submit}
                disabled={submitting || selectedStars < 1}
                className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-brand text-white hover:bg-brand-dark transition-colors disabled:opacity-50"
              >
                {submitting ? '…' : bi('Envoyer', 'Submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Stars rounded to the nearest half — keeps the average legible without
// importing a chart lib. ★ for full / ½ / ☆ for empty.
function StarRow({ value }: { value: number }) {
  const halves = Math.round(value * 2) // 0..10
  return (
    <p className="text-amber-400 leading-none">
      {Array.from({ length: 5 }, (_, i) => {
        const slot = (i + 1) * 2
        if (halves >= slot)     return '★'
        if (halves === slot - 1) return '⯨'  // half-star — graceful fallback to ★ if font lacks it
        return '☆'
      }).join('')}
    </p>
  )
}
