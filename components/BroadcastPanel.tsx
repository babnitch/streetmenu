'use client'

import { useState, useEffect, useCallback } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import PhoneInput from '@/components/PhoneInput'
import { getCountryFromCity } from '@/lib/phoneValidation'
import { categoryLabel } from '@/lib/categoryLabels'

const CITIES = ['Yaoundé', 'Abidjan', 'Dakar', 'Lomé'] as const
const CATEGORIES = [
  'Concert', 'Festival', 'BT/Club', 'Sport', 'Culture', 'Gastronomie', 'Enfants', 'Business', 'Autre',
] as const
const TITLE_MAX = 100
const MESSAGE_MAX = 1000

interface Eligibility {
  eligible: boolean
  blocked: boolean
  asPublisher: boolean
  asRestaurants: Array<{ id: string; name: string }>
  pricing: { price_per_recipient: number; min_charge: number; max_message_length: number } | null
  rate_limited: boolean
}

interface PastBroadcast {
  id: string
  sender_type: 'publisher' | 'restaurant'
  title: string
  target_city: string
  recipient_count: number
  cost: number
  payment_status: string
  status: string
  sent_at: string | null
  created_at: string
  restaurants?: { name: string } | null
}

// Paid broadcast composer + history list. Mounts inside the Profile tab.
// Self-checks eligibility on mount and only renders for verified publishers
// or approved restaurant owners.
export default function BroadcastPanel() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [eligibility, setEligibility] = useState<Eligibility | null>(null)
  const [pastBroadcasts, setPastBroadcasts] = useState<PastBroadcast[]>([])
  const [composeOpen, setComposeOpen] = useState(false)

  // Form state
  const [senderType, setSenderType] = useState<'publisher' | 'restaurant'>('publisher')
  const [restaurantId, setRestaurantId] = useState<string>('')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [targetCity, setTargetCity] = useState<typeof CITIES[number]>('Yaoundé')
  const [targetCategories, setTargetCategories] = useState<Set<string>>(new Set())

  // Preview state
  const [preview, setPreview] = useState<{ recipients: number; cost: number } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Pay state
  const [phoneNumber, setPhoneNumber] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const loadEligibility = useCallback(async () => {
    try {
      const res = await fetch('/api/broadcasts/eligibility', { cache: 'no-store' })
      const d = await res.json() as Eligibility
      setEligibility(d)
      // Default sender_type to the first available option
      if (d.asPublisher) setSenderType('publisher')
      else if (d.asRestaurants.length > 0) {
        setSenderType('restaurant')
        setRestaurantId(d.asRestaurants[0].id)
      }
    } catch { /* not eligible */ }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/broadcasts/my', { cache: 'no-store' })
      const d = await res.json()
      if (Array.isArray(d?.broadcasts)) setPastBroadcasts(d.broadcasts)
    } catch { /* anon */ }
  }, [])

  useEffect(() => { loadEligibility(); loadHistory() }, [loadEligibility, loadHistory])

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  function toggleCategory(cat: string) {
    setTargetCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
    setPreview(null)
  }

  async function runPreview() {
    setPreviewLoading(true)
    try {
      const res = await fetch('/api/broadcasts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_city: targetCity,
          target_categories: targetCategories.size === 0 ? null : Array.from(targetCategories),
        }),
      })
      const d = await res.json()
      if (!res.ok) {
        flash(d?.error ?? bi('Erreur', 'Error'))
        return
      }
      setPreview({ recipients: d.recipients, cost: d.cost })
    } catch (e) {
      flash((e as Error).message)
    } finally {
      setPreviewLoading(false)
    }
  }

  async function payAndSend() {
    if (!title.trim() || !message.trim() || !phoneNumber.trim()) {
      flash(bi('Titre, message et numéro requis', 'Title, message and phone required'))
      return
    }
    if (senderType === 'restaurant' && !restaurantId) {
      flash(bi('Sélectionnez un restaurant', 'Select a restaurant'))
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/broadcasts/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          message,
          target_city: targetCity,
          target_categories: targetCategories.size === 0 ? null : Array.from(targetCategories),
          sender_type: senderType,
          restaurant_id: senderType === 'restaurant' ? restaurantId : null,
          phone_number: phoneNumber,
        }),
      })
      const d = await res.json()
      if (!res.ok) {
        flash(d?.error ?? bi('Erreur', 'Error'))
        return
      }
      flash(bi(
        `💰 Confirmez le paiement sur votre téléphone (${d.recipients} abonnés).`,
        `💰 Approve the payment on your phone (${d.recipients} subscribers).`,
      ))
      setComposeOpen(false)
      setTitle('')
      setMessage('')
      setPhoneNumber('')
      setTargetCategories(new Set())
      setPreview(null)
      // Refresh history a couple of times to catch status changes
      setTimeout(loadHistory, 2000)
      setTimeout(loadHistory, 8000)
      setTimeout(loadEligibility, 8000)
    } catch (e) {
      flash((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  // Don't render anything for ineligible accounts — the panel just disappears.
  if (!eligibility) return null
  if (eligibility.blocked) {
    return (
      <div className="bg-rose-50 border border-rose-100 rounded-xl p-3 text-sm text-rose-700">
        🚫 {bi(
          'Votre compte est bloqué pour les diffusions par l\'administration.',
          'Your broadcasting privileges have been suspended by the administration.',
        )}
      </div>
    )
  }
  if (!eligibility.eligible) return null

  const pricing = eligibility.pricing ?? { price_per_recipient: 50, min_charge: 1000, max_message_length: 1000 }
  const titleLeft = TITLE_MAX - title.length
  const messageLeft = MESSAGE_MAX - message.length

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
          📢 {bi('Diffuser un message', 'Broadcast a message')}
        </p>
        {!composeOpen && (
          <button
            onClick={() => setComposeOpen(true)}
            disabled={eligibility.rate_limited}
            className="text-xs font-semibold text-brand hover:text-brand-dark disabled:opacity-50"
          >
            {bi('+ Nouveau', '+ New')}
          </button>
        )}
      </div>

      {eligibility.rate_limited && !composeOpen && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-xs text-amber-800 mb-3">
          ⏳ {bi(
            'Vous avez déjà diffusé un message aujourd\'hui. Réessayez demain.',
            'You\'ve already broadcast today. Try again tomorrow.',
          )}
        </div>
      )}

      {composeOpen && (
        <div className="bg-white border border-divider rounded-xl p-4 space-y-3 mb-4">
          {/* Sender selection */}
          {eligibility.asPublisher && eligibility.asRestaurants.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
                {bi('Diffuser en tant que', 'Broadcast as')}
              </label>
              <select
                value={senderType === 'publisher' ? 'publisher' : restaurantId}
                onChange={e => {
                  if (e.target.value === 'publisher') {
                    setSenderType('publisher')
                    setRestaurantId('')
                  } else {
                    setSenderType('restaurant')
                    setRestaurantId(e.target.value)
                  }
                }}
                className="w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm"
              >
                <option value="publisher">🎉 {bi('Éditeur', 'Publisher')}</option>
                {eligibility.asRestaurants.map(r => (
                  <option key={r.id} value={r.id}>🏪 {r.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Title */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-ink-secondary">
                {bi('Titre', 'Title')}
              </label>
              <span className={`text-xs ${titleLeft < 0 ? 'text-rose-500' : 'text-ink-tertiary'}`}>
                {titleLeft}
              </span>
            </div>
            <input
              value={title}
              onChange={e => setTitle(e.target.value.slice(0, TITLE_MAX))}
              maxLength={TITLE_MAX}
              placeholder={bi('Concert ce vendredi à 20h', 'Concert this Friday at 8pm')}
              className="w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm"
            />
          </div>

          {/* Message */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-ink-secondary">
                {bi('Message', 'Message')}
              </label>
              <span className={`text-xs ${messageLeft < 0 ? 'text-rose-500' : 'text-ink-tertiary'}`}>
                {messageLeft}
              </span>
            </div>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value.slice(0, MESSAGE_MAX))}
              maxLength={MESSAGE_MAX}
              rows={4}
              placeholder={bi('Détails du message…', 'Message details…')}
              className="w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm"
            />
          </div>

          {/* Target city */}
          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
              {bi('Ville cible', 'Target city')}
            </label>
            <select
              value={targetCity}
              onChange={e => { setTargetCity(e.target.value as typeof CITIES[number]); setPreview(null) }}
              className="w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm"
            >
              {CITIES.map(c => <option key={c} value={c}>📍 {c}</option>)}
            </select>
          </div>

          {/* Categories (optional filter) */}
          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
              {bi('Catégories (optionnel — toutes par défaut)', 'Categories (optional — all by default)')}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map(cat => {
                const on = targetCategories.has(cat)
                return (
                  <button
                    key={cat}
                    onClick={() => toggleCategory(cat)}
                    className={`text-xs font-semibold px-2.5 py-1 rounded-full transition-colors ${
                      on ? 'bg-brand text-white' : 'bg-surface-muted text-ink-tertiary hover:bg-divider'
                    }`}
                  >
                    {categoryLabel(cat, locale)}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Preview block */}
          <div className="border-t border-divider pt-3 space-y-2">
            <button
              onClick={runPreview}
              disabled={previewLoading}
              className="w-full bg-surface-muted hover:bg-divider disabled:opacity-50 text-ink-primary font-semibold py-2 rounded-xl text-sm transition-colors"
            >
              {previewLoading
                ? '…'
                : bi('🔎 Estimer le coût', '🔎 Estimate cost')}
            </button>
            {preview && (
              <div className="bg-brand-light/30 border border-brand-light rounded-xl p-3 text-sm">
                <p className="text-ink-primary">
                  <span className="font-semibold">~{preview.recipients}</span>{' '}
                  {bi('abonnés', 'subscribers')} × {pricing.price_per_recipient} FCFA
                </p>
                <p className="text-ink-primary font-bold mt-1">
                  💰 {preview.cost.toLocaleString()} FCFA
                </p>
                <p className="text-xs text-ink-tertiary mt-1">
                  {bi(
                    `Min ${pricing.min_charge.toLocaleString()} FCFA`,
                    `Min ${pricing.min_charge.toLocaleString()} FCFA`,
                  )}
                </p>
              </div>
            )}
          </div>

          {/* Phone + pay */}
          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
              {bi('Numéro MoMo (paiement)', 'MoMo number (payment)')}
            </label>
            <PhoneInput
              value={phoneNumber}
              onChange={(full) => setPhoneNumber(full)}
              defaultCountry={getCountryFromCity(targetCity).iso}
            />
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <button
              onClick={payAndSend}
              disabled={submitting || !title.trim() || !message.trim() || !phoneNumber.trim()}
              className="w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
            >
              {submitting ? '…' : bi('💰 Payer et envoyer', '💰 Pay and send')}
            </button>
            <button
              onClick={() => { setComposeOpen(false); setPreview(null) }}
              className="w-full text-ink-tertiary hover:text-ink-primary font-medium py-2 text-sm transition-colors"
            >
              {bi('Annuler', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      {/* History */}
      {pastBroadcasts.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-ink-tertiary uppercase">
            {bi('Historique', 'History')}
          </p>
          {pastBroadcasts.slice(0, 5).map(b => {
            const statusLabel = b.status === 'sent' ? '✅' : b.status === 'failed' ? '❌' : b.status === 'sending' ? '📨' : '⏳'
            return (
              <div key={b.id} className="bg-surface-muted rounded-xl p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-ink-primary truncate">
                    {statusLabel} {b.title}
                  </span>
                  <span className="text-ink-tertiary flex-shrink-0">
                    {new Date(b.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
                  </span>
                </div>
                <p className="text-ink-tertiary mt-0.5">
                  📍 {b.target_city} · {b.recipient_count} {bi('abonnés', 'subs')} · {b.cost.toLocaleString()} FCFA
                </p>
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
