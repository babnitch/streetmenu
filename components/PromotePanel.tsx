'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useBi } from '@/lib/languageContext'
import PhoneInput from '@/components/PhoneInput'
import { getCountryFromCity } from '@/lib/phoneValidation'

type Placement = 'top_list' | 'feed_card' | 'banner'
type TargetType = 'restaurant' | 'event'
const PLACEMENTS: Placement[] = ['top_list', 'feed_card', 'banner']

interface Pricing {
  placement:         Placement
  price_per_day:     number
  min_duration_days: number
  max_duration_days: number
}

interface Eligibility {
  eligible:    boolean
  restaurants: Array<{ id: string; name: string; city: string }>
  events:      Array<{ id: string; title: string; city: string }>
  pricing:     Record<Placement, Pricing> | null
}

interface MyPromo {
  id:             string
  target_type:    TargetType
  target_id:      string
  target_name:    string
  placement:      Placement
  city:           string
  start_date:     string
  end_date:       string
  total_budget:   number
  amount_spent:   number
  impressions:    number
  clicks:         number
  payment_status: string
  status:         string
  created_at:     string
}

// Today's date in YYYY-MM-DD for the <input type="date"> min attribute.
function todayISO(): string {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

function placementLabel(p: Placement, bi: (a: string, b: string) => string): string {
  if (p === 'top_list')  return bi('🔝 En tête de liste', '🔝 Top of list')
  if (p === 'feed_card') return bi('📌 Carte dans le fil', '📌 Card in feed')
  return bi('📢 Bannière', '📢 Banner')
}

// Days inclusive between two YYYY-MM-DD strings.
function daysInclusive(startISO: string, endISO: string): number {
  if (!startISO || !endISO) return 0
  const s = new Date(startISO).getTime()
  const e = new Date(endISO).getTime()
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0
  return Math.max(1, Math.round((e - s) / (24 * 60 * 60 * 1000)) + 1)
}

// Promotion composer + history list. Mounts inside the Profile tab and
// only renders for accounts that own at least one approved restaurant
// or organize at least one active event.
export default function PromotePanel() {
  const bi = useBi()
  const [elig, setElig] = useState<Eligibility | null>(null)
  const [pastPromos, setPastPromos] = useState<MyPromo[]>([])
  const [composeOpen, setComposeOpen] = useState(false)

  // Form state
  const [targetType, setTargetType] = useState<TargetType>('restaurant')
  const [targetId, setTargetId] = useState<string>('')
  const [placement, setPlacement] = useState<Placement>('top_list')
  const [startDate, setStartDate] = useState<string>(todayISO())
  const [endDate, setEndDate] = useState<string>(todayISO())
  const [phoneNumber, setPhoneNumber] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const loadEligibility = useCallback(async () => {
    try {
      const res = await fetch('/api/promotions/eligibility', { cache: 'no-store' })
      const d = await res.json() as Eligibility
      setElig(d)
      // Default target = first restaurant (else first event)
      if (d.restaurants.length > 0) {
        setTargetType('restaurant')
        setTargetId(d.restaurants[0].id)
      } else if (d.events.length > 0) {
        setTargetType('event')
        setTargetId(d.events[0].id)
      }
    } catch { /* not eligible */ }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/promotions/my', { cache: 'no-store' })
      const d = await res.json()
      if (Array.isArray(d?.promotions)) setPastPromos(d.promotions)
    } catch { /* anon */ }
  }, [])

  useEffect(() => { loadEligibility(); loadHistory() }, [loadEligibility, loadHistory])

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  // Resolve the city to charge MoMo for: the target's own city, so an
  // event in Dakar promotion pays via Senegal regardless of where the
  // promoter lives.
  const targetCity = useMemo(() => {
    if (!elig) return ''
    if (targetType === 'restaurant') {
      return elig.restaurants.find(r => r.id === targetId)?.city ?? ''
    }
    return elig.events.find(e => e.id === targetId)?.city ?? ''
  }, [elig, targetType, targetId])

  const pricing = elig?.pricing?.[placement] ?? null
  const days = daysInclusive(startDate, endDate)
  const cost = pricing ? days * pricing.price_per_day : 0
  const durationValid = !pricing
    ? true
    : days >= pricing.min_duration_days && days <= pricing.max_duration_days

  async function payAndLaunch() {
    if (!targetId || !phoneNumber.trim()) {
      flash(bi('Champ requis manquant', 'Missing required field'))
      return
    }
    if (!durationValid) {
      flash(bi('Durée invalide', 'Invalid duration'))
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/promotions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_type:  targetType,
          target_id:    targetId,
          placement,
          city:         targetCity,
          start_date:   new Date(`${startDate}T00:00:00`).toISOString(),
          end_date:     new Date(`${endDate}T23:59:59`).toISOString(),
          phone_number: phoneNumber,
        }),
      })
      const d = await res.json()
      if (!res.ok) {
        flash(d?.error ?? bi('Erreur', 'Error'))
        return
      }
      flash(bi(
        '💰 Confirmez le paiement sur votre téléphone. Promotion en attente de validation.',
        '💰 Approve the payment on your phone. Promotion pending review.',
      ))
      setComposeOpen(false)
      setPhoneNumber('')
      setTimeout(loadHistory, 2000)
      setTimeout(loadHistory, 8000)
    } catch (e) {
      flash((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function changeStatus(id: string, action: 'pause' | 'resume' | 'cancel') {
    try {
      const res = await fetch(`/api/promotions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (res.ok) await loadHistory()
      else {
        const d = await res.json().catch(() => ({}))
        flash(d?.error ?? bi('Erreur', 'Error'))
      }
    } catch { /* swallow */ }
  }

  if (!elig) return null
  if (!elig.eligible) return null
  const pricingMap = elig.pricing

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
          📢 {bi('Promouvoir', 'Promote')}
        </p>
        {!composeOpen && (
          <button
            onClick={() => setComposeOpen(true)}
            className="text-xs font-semibold text-brand hover:text-brand-dark"
          >
            {bi('+ Nouvelle promotion', '+ New promotion')}
          </button>
        )}
      </div>

      {composeOpen && (
        <div className="bg-white border border-divider rounded-xl p-4 space-y-3 mb-4">
          {/* Target type */}
          {(elig.restaurants.length > 0 && elig.events.length > 0) && (
            <div>
              <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
                {bi('Type', 'Type')}
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => { setTargetType('restaurant'); setTargetId(elig.restaurants[0]?.id ?? '') }}
                  className={`flex-1 px-3 py-2 rounded-xl text-sm font-semibold transition-colors ${
                    targetType === 'restaurant' ? 'bg-brand text-white' : 'bg-surface-muted text-ink-secondary'
                  }`}
                >
                  🏪 {bi('Restaurant', 'Restaurant')}
                </button>
                <button
                  onClick={() => { setTargetType('event'); setTargetId(elig.events[0]?.id ?? '') }}
                  className={`flex-1 px-3 py-2 rounded-xl text-sm font-semibold transition-colors ${
                    targetType === 'event' ? 'bg-brand text-white' : 'bg-surface-muted text-ink-secondary'
                  }`}
                >
                  🎉 {bi('Événement', 'Event')}
                </button>
              </div>
            </div>
          )}

          {/* Target item */}
          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
              {bi('À promouvoir', 'To promote')}
            </label>
            <select
              value={targetId}
              onChange={e => setTargetId(e.target.value)}
              className="w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm"
            >
              {targetType === 'restaurant'
                ? elig.restaurants.map(r => <option key={r.id} value={r.id}>{r.name} — {r.city}</option>)
                : elig.events.map(ev => <option key={ev.id} value={ev.id}>{ev.title} — {ev.city}</option>)
              }
            </select>
          </div>

          {/* Placement */}
          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
              {bi('Emplacement', 'Placement')}
            </label>
            <div className="space-y-1.5">
              {PLACEMENTS.map(pl => {
                const p = pricingMap?.[pl]
                const active = placement === pl
                return (
                  <button
                    key={pl}
                    onClick={() => setPlacement(pl)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-sm transition-colors ${
                      active ? 'bg-brand-light text-ink-primary border border-brand' : 'bg-surface-muted text-ink-secondary border border-transparent'
                    }`}
                  >
                    <span>{placementLabel(pl, bi)}</span>
                    {p && <span className="text-xs font-mono">{p.price_per_day.toLocaleString()} FCFA/j</span>}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
                {bi('Début', 'Start')}
              </label>
              <input
                type="date"
                value={startDate}
                min={todayISO()}
                onChange={e => setStartDate(e.target.value)}
                className="w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
                {bi('Fin', 'End')}
              </label>
              <input
                type="date"
                value={endDate}
                min={startDate || todayISO()}
                onChange={e => setEndDate(e.target.value)}
                className="w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Cost preview */}
          {pricing && (
            <div className={`rounded-xl p-3 border text-sm ${durationValid ? 'bg-brand-light/30 border-brand-light' : 'bg-rose-50 border-rose-100'}`}>
              <p className="text-ink-primary">
                <span className="font-semibold">{days}</span> {bi('jours', 'days')} × {pricing.price_per_day.toLocaleString()} FCFA
              </p>
              <p className="font-bold text-ink-primary mt-1">
                💰 {cost.toLocaleString()} FCFA
              </p>
              {!durationValid && (
                <p className="text-xs text-rose-600 mt-1">
                  {bi(
                    `Durée: ${pricing.min_duration_days} - ${pricing.max_duration_days} jours`,
                    `Duration: ${pricing.min_duration_days} - ${pricing.max_duration_days} days`,
                  )}
                </p>
              )}
              {targetCity && (
                <p className="text-xs text-ink-tertiary mt-2">
                  {bi(
                    `Votre ${targetType === 'restaurant' ? 'restaurant' : 'événement'} apparaîtra à ${targetCity} pendant ${days} jour${days > 1 ? 's' : ''}.`,
                    `Your ${targetType} will appear in ${targetCity} for ${days} day${days > 1 ? 's' : ''}.`,
                  )}
                </p>
              )}
            </div>
          )}

          {/* MoMo */}
          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
              {bi('Numéro MoMo (paiement)', 'MoMo number (payment)')}
            </label>
            <PhoneInput
              value={phoneNumber}
              onChange={(full) => setPhoneNumber(full)}
              defaultCountry={targetCity ? getCountryFromCity(targetCity).iso : undefined}
            />
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <button
              onClick={payAndLaunch}
              disabled={submitting || !durationValid || !targetId || !phoneNumber.trim()}
              className="w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
            >
              {submitting ? '…' : bi('💰 Payer et lancer', '💰 Pay and launch')}
            </button>
            <button
              onClick={() => setComposeOpen(false)}
              className="w-full text-ink-tertiary hover:text-ink-primary font-medium py-2 text-sm transition-colors"
            >
              {bi('Annuler', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      {/* History */}
      {pastPromos.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-ink-tertiary uppercase">
            {bi('Mes promotions', 'My promotions')}
          </p>
          {pastPromos.slice(0, 8).map(p => {
            const ctr = p.impressions > 0 ? ((p.clicks / p.impressions) * 100).toFixed(1) : '0.0'
            const statusEmoji = p.status === 'active' ? '🟢' :
                                p.status === 'pending_review' ? '⏳' :
                                p.status === 'paused' ? '⏸️' :
                                p.status === 'rejected' ? '❌' :
                                p.status === 'completed' ? '✅' : '📝'
            return (
              <div key={p.id} className="bg-surface-muted rounded-xl p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-ink-primary truncate">
                    {statusEmoji} {p.target_name}
                  </span>
                  <span className="text-ink-tertiary flex-shrink-0">
                    {new Date(p.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
                  </span>
                </div>
                <p className="text-ink-tertiary mt-0.5">
                  {placementLabel(p.placement, bi)} · 📍 {p.city} · {p.total_budget.toLocaleString()} FCFA
                </p>
                <p className="text-ink-tertiary mt-0.5">
                  👁️ {p.impressions} · 🖱️ {p.clicks} · {ctr}% CTR
                </p>
                <div className="flex gap-2 mt-2">
                  {p.status === 'active' && (
                    <button
                      onClick={() => changeStatus(p.id, 'pause')}
                      className="text-xs font-semibold text-ink-secondary hover:text-ink-primary"
                    >
                      {bi('⏸️ Pause', '⏸️ Pause')}
                    </button>
                  )}
                  {p.status === 'paused' && (
                    <button
                      onClick={() => changeStatus(p.id, 'resume')}
                      className="text-xs font-semibold text-brand hover:text-brand-dark"
                    >
                      {bi('▶️ Reprendre', '▶️ Resume')}
                    </button>
                  )}
                  {p.status === 'draft' && (
                    <button
                      onClick={() => changeStatus(p.id, 'cancel')}
                      className="text-xs font-semibold text-rose-600 hover:text-rose-700"
                    >
                      {bi('Annuler', 'Cancel')}
                    </button>
                  )}
                </div>
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
