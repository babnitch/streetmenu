'use client'
import RefPicker, { OTHER, pickerBody } from '@/components/RefPicker'
import { useRefData } from '@/lib/useRefData'

export const dynamic = 'force-dynamic'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useLanguage, useBi } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'
import { proLoginHref } from '@/lib/lastPhone'
import { formatPhoneDisplay } from '@/lib/phoneValidation'
import { canPayOnline, type PaymentMode } from '@/lib/paymentMode'
import { validateEventRange, EVENT_RANGE_ERRORS, eventDays } from '@/lib/eventDate'
import { capacityFromTiers, capacityTotalLine } from '@/lib/eventCapacity'
import { EVENT_POSTER_REQUIRED } from '@/lib/pictureRequired'



interface SessionUser { id: string; name: string; phone: string; role: string }

export default function SubmitEventPage() {
  const { t, locale } = useLanguage()
  const bi = useBi()
  useRefData()
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Login is now REQUIRED. Anonymous visitors see a "Connectez-vous"
  // gate that bounces them to /account with a return URL.
  const [me, setMe] = useState<SessionUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => { if (data?.user?.role === 'customer') setMe(data.user) })
      .catch(() => null)
      .finally(() => setAuthLoading(false))
  }, [])

  // Pre-fill the organiser name from the Pro profile (/pro/profile). It stays
  // editable here, per event; an empty field is the only one filled.
  useEffect(() => {
    if (!me) return
    let cancelled = false
    fetch('/api/pro/profile', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        const name = typeof d?.profile?.pro_name === 'string' ? d.profile.pro_name : ''
        const extra = typeof d?.profile?.pro_notify_phone === 'string' ? formatPhoneDisplay(d.profile.pro_notify_phone) : ''
        if (cancelled) return
        setForm(f => ({
          ...f,
          organizer_name: f.organizer_name || name,
          notify_phone:   f.notify_phone || extra,
        }))
      })
      .catch(() => { /* the field stays empty */ })
    return () => { cancelled = true }
  }, [me])

  // Submission outcome — auto_approved sees a different success screen
  // than admin-pending.
  const [autoApproved, setAutoApproved] = useState(false)

  const [form, setForm] = useState({
    title: '',
    description: '',
    date: '',
    time: '',
    end_date: '',
    end_time: '',
    venue: '',
    city: '',
    neighborhood: '',
    category: '',
    price: '',
    notify_phone: '',
    organizer_name: '',
    max_tickets: '',
    payment_mode: 'reservation_only' as PaymentMode,
    whatsapp_payment_enabled: false,
    requires_confirmation: false,
  })
  const [cityOther, setCityOther] = useState('')
  const [categoryOther, setCategoryOther] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  // Multi-tier ticketing — when enabled, `form.price` + `form.max_tickets`
  // are ignored and the API creates one event_ticket_tiers row per entry
  // in `tiers[]`. At least one tier is required when the toggle is on.
  interface TierDraft {
    name:         string
    name_en:      string
    price:        string  // string-typed so empty value stays controlled
    max_quantity: string
    description:  string
  }
  const [useTiers, setUseTiers] = useState(false)
  const [tiers, setTiers] = useState<TierDraft[]>([
    { name: '', name_en: '', price: '', max_quantity: '', description: '' },
  ])

  function addTier() {
    setTiers(prev => [...prev, { name: '', name_en: '', price: '', max_quantity: '', description: '' }])
  }
  function removeTier(idx: number) {
    setTiers(prev => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx))
  }
  function updateTier(idx: number, field: keyof TierDraft, value: string) {
    setTiers(prev => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t))
  }

  // Preset templates — quick-fill the tier list. Replaces whatever is
  // currently entered (the form is otherwise empty when the user picks
  // a template).
  function applyTemplate(name: 'standard' | 'family' | 'vip') {
    if (name === 'standard') {
      setTiers([
        { name: 'Early Bird',  name_en: 'Early Bird', price: '1500', max_quantity: '', description: 'Accès général' },
        { name: 'Plein tarif', name_en: 'Full Price', price: '3000', max_quantity: '', description: 'Accès général' },
        { name: 'Dernière minute', name_en: 'Last Minute', price: '4000', max_quantity: '', description: 'Accès général' },
      ])
    } else if (name === 'family') {
      setTiers([
        { name: 'Adulte',    name_en: 'Adult',  price: '3000', max_quantity: '', description: '' },
        { name: 'Enfant',    name_en: 'Kids',   price: '0',    max_quantity: '', description: 'Moins de 12 ans' },
        { name: 'Famille x4', name_en: 'Family of 4', price: '9000', max_quantity: '', description: '2 adultes + 2 enfants' },
      ])
    } else {
      setTiers([
        { name: 'Standard', name_en: 'Standard', price: '3000', max_quantity: '', description: '' },
        { name: 'VIP',      name_en: 'VIP',      price: '10000', max_quantity: '20', description: 'Accès premium' },
      ])
    }
  }

  function set(field: string, value: string | boolean) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhoto(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  // Capacity is per day: the number of days the form's dates cover, and the
  // seats per day (sum of the tiers' max when tiers are on).
  const dayCount = form.date ? eventDays({ date: form.date, end_date: form.end_date || null }).length : 0
  const tierCapacity = capacityFromTiers(
    tiers.filter(t => t.name.trim()).map(t => Number.parseInt(t.max_quantity, 10) || 0),
  )
  const perDayCapacity = useTiers ? tierCapacity : Number.parseInt(form.max_tickets, 10) || 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!form.title || !form.date || !form.city || !form.category || !form.organizer_name
        || (form.city === OTHER && cityOther.trim().length < 2) || (form.category === OTHER && !categoryOther.trim())) {
      setError(t('evt.errorRequired'))
      return
    }

    // V5: every new event needs a poster.
    if (!photo) {
      setError(bi(EVENT_POSTER_REQUIRED.fr, EVENT_POSTER_REQUIRED.en))
      return
    }

    // Start/end range — same rules the API applies. Blank end = single-day.
    const rangeError = validateEventRange({
      date: form.date, time: form.time || null, end_date: form.end_date || null, end_time: form.end_time || null,
    })
    if (rangeError) {
      setError(bi(EVENT_RANGE_ERRORS[rangeError].fr, EVENT_RANGE_ERRORS[rangeError].en))
      return
    }

    // Tier-mode validation: at least one row, every row needs a name +
    // numeric price (0 is fine — denotes a free tier).
    let tierPayload: Array<{ name: string; name_en: string | null; price: number; max_quantity: number; description: string | null }> | null = null
    if (useTiers) {
      const cleaned = tiers
        .map(t => ({
          name:         t.name.trim(),
          name_en:      t.name_en.trim() || null,
          price:        Number.parseInt(t.price, 10),
          max_quantity: Number.parseInt(t.max_quantity, 10) || 0,
          description:  t.description.trim() || null,
        }))
        .filter(t => t.name.length > 0)
      if (cleaned.length === 0) {
        setError(bi('Ajoutez au moins un tarif.', 'Add at least one tier.'))
        return
      }
      if (cleaned.some(t => !Number.isFinite(t.price) || t.price < 0)) {
        setError(bi('Prix de tarif invalide.', 'Invalid tier price.'))
        return
      }
      tierPayload = cleaned
    }

    setSubmitting(true)

    // Everything below is wrapped so a thrown fetch (network drop, session
    // expiry) or a non-JSON response (a 500 HTML error page) can't leave the
    // form stuck on the spinner with no feedback — the earlier failure mode
    // that read as "submit does nothing / nothing saves".
    try {
      let cover_photo = ''
      // Server-side compression via sharp → WebP / 800×450 / EXIF
      // stripped / blur placeholder. See /api/upload/image. The poster is
      // required (V5), so a failed upload stops the submit here.
      try {
        const fd = new FormData()
        fd.append('file', photo)
        fd.append('kind', 'event_poster')
        fd.append('pathPrefix', 'events')
        const r = await fetch('/api/upload/image', { method: 'POST', body: fd })
        if (r.ok) {
          const j = await r.json()
          if (typeof j?.url === 'string') cover_photo = j.url
        } else {
          console.warn('[events/submit] photo upload failed:', r.status)
        }
      } catch (err) {
        console.warn('[events/submit] photo upload threw:', err)
      }
      if (!cover_photo) {
        setError(`${bi(EVENT_POSTER_REQUIRED.fr, EVENT_POSTER_REQUIRED.en)} — ${bi('l\'envoi a échoué, réessayez.', 'the upload failed, please try again.')}`)
        return
      }

      const payload = {
        title:           form.title,
        description:     form.description,
        date:            form.date,
        time:            form.time,
        end_date:        form.end_date || null,
        end_time:        form.end_time || null,
        venue:           form.venue,
        ...pickerBody('city', form.city, cityOther),
        neighborhood:    form.neighborhood,
        ...pickerBody('category', form.category, categoryOther),
        ticket_price:    form.price ? Math.round(Number(form.price)) : null,
        max_tickets:     form.max_tickets ? parseInt(form.max_tickets, 10) : 0,
        payment_mode:    form.payment_mode,
        whatsapp_payment_enabled: !!form.whatsapp_payment_enabled,
        requires_confirmation: !!form.requires_confirmation,
        cover_photo,
        notify_phone:    form.notify_phone.trim(),
        organizer_name:  form.organizer_name,
        tiers:           tierPayload,
      }
      console.log('[events/submit] POST payload:', payload)

      // Hand off to /api/events/submit so the auto-approve gate + counter
      // increments happen server-side under the trust model. The route also
      // writes audit rows + pings the submitter over WhatsApp.
      const res  = await fetch('/api/events/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      console.log('[events/submit] response:', res.status, data)
      if (!res.ok) {
        setError(data?.error ?? t('evt.errorServer'))
        return
      }
      setAutoApproved(!!data.auto_approved)
      setSuccess(true)
    } catch (err) {
      console.error('[events/submit] submit failed:', err)
      setError(t('evt.errorServer'))
    } finally {
      setSubmitting(false)
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen flex items-center justify-center bg-surface">
        <div className="text-3xl animate-pulse text-ink-tertiary">…</div>
      </div>
    )
  }

  if (!me) {
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen flex flex-col items-center justify-center px-4 text-center bg-surface">
        <div className="w-20 h-20 bg-brand-light rounded-3xl flex items-center justify-center text-4xl mb-5">🔒</div>
        <h1 className="text-2xl font-bold text-ink-primary mb-2">
          {bi('Connectez-vous pour publier', 'Log in to publish')}
        </h1>
        <p className="text-ink-secondary text-sm mb-6 max-w-xs">
          {bi(
            'La publication d\'événements est réservée aux comptes connectés. C\'est rapide — un code par WhatsApp suffit.',
            'Publishing events requires a logged-in account. Quick — one WhatsApp code is enough.',
          )}
        </p>
        <Link
          href={proLoginHref('/events/submit')}
          className="bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors"
        >
          {bi('Se connecter', 'Log in')}
        </Link>
      </div>
    )
  }

  if (success) {
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen flex flex-col items-center justify-center px-4 text-center bg-surface">
        <div className="w-20 h-20 bg-brand-light rounded-3xl flex items-center justify-center text-4xl mb-5">{autoApproved ? '🎉' : '✅'}</div>
        <h1 className="text-2xl font-bold text-ink-primary mb-2">
          {autoApproved
            ? bi('Événement publié!', 'Event published!')
            : bi('Événement soumis!', 'Event submitted!')}
        </h1>
        <p className="text-ink-secondary text-sm mb-6 max-w-xs">
          {autoApproved
            ? bi(
                'Visible immédiatement sur Tchop & Ndjoka.',
                'Live immediately on Tchop & Ndjoka.',
              )
            : bi(
                'Il sera visible après approbation par un admin.',
                'It will be visible after admin approval.',
              )}
        </p>
        <Link
          href="/pro/events"
          className="bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors"
        >
          🎉 {bi('Voir mes événements', 'See my events')}
        </Link>
        <Link href="/events" className="mt-3 text-sm font-semibold text-ink-secondary hover:text-ink-primary underline underline-offset-2">
          {t('evt.backToEvents')}
        </Link>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <div className="max-w-xl mx-auto px-4 py-6">

        {/* Title */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-ink-primary">{t('evt.submitTitle')}</h1>
          <p className="text-sm text-ink-tertiary mt-1">{t('evt.submitSub')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Poster — shown as a portrait poster on the Events page. */}
          <div>
            <label className={LABEL}>{bi('Affiche de l\'événement *', 'Event poster *')}</label>
            <div className="flex gap-3 items-start">
              <button type="button" onClick={() => fileInputRef.current?.click()}
                className="relative w-32 aspect-[4/5] flex-shrink-0 border-2 border-dashed border-brand-badge rounded-2xl overflow-hidden hover:border-brand transition-colors">
                {photoPreview ? (
                  <Image src={photoPreview} alt="preview" fill className="object-cover" />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-3xl bg-brand-light" aria-hidden="true">🖼️</span>
                )}
              </button>
              <div className="text-xs text-ink-tertiary space-y-1 pt-1">
                <p className="text-sm text-ink-secondary font-semibold">
                  {photoPreview ? bi('Changer l\'affiche', 'Change the poster') : bi('Ajouter une affiche', 'Add a poster')}
                </p>
                <p>{bi('Format conseillé : 1080 × 1350 px (portrait 4:5).', 'Recommended: 1080 × 1350 px (portrait 4:5).')}</p>
                <p className="font-semibold text-ink-secondary">{bi('Obligatoire.', 'Required.')}</p>
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePhoto} />
          </div>

          {/* Title */}
          <Field label={t('evt.titleLbl')}>
            <input className={INPUT} value={form.title} onChange={e => set('title', e.target.value)} placeholder="ex: Concert Jazz de Yaoundé" />
          </Field>

          {/* Description */}
          <Field label={t('evt.descLbl')}>
            <textarea
              className={`${INPUT} min-h-[80px] resize-none`}
              value={form.description}
              onChange={e => set('description', e.target.value)}
              rows={3}
            />
          </Field>

          {/* Start */}
          <div className="grid grid-cols-2 gap-3">
            <Field label={bi('Date de début', 'Start date')}>
              <input type="date" className={INPUT} value={form.date} onChange={e => set('date', e.target.value)} />
            </Field>
            <Field label={bi('Heure de début', 'Start time')}>
              <input type="time" className={INPUT} value={form.time} onChange={e => set('time', e.target.value)} />
            </Field>
          </div>

          {/* End — optional; blank = same day as the start */}
          <div className="grid grid-cols-2 gap-3">
            <Field label={bi('Date de fin (optionnel)', 'End date (optional)')}>
              <input type="date" className={INPUT} min={form.date || undefined} value={form.end_date} onChange={e => set('end_date', e.target.value)} />
            </Field>
            <Field label={bi('Heure de fin (optionnel)', 'End time (optional)')}>
              <input type="time" className={INPUT} value={form.end_time} onChange={e => set('end_time', e.target.value)} />
            </Field>
          </div>

          {/* Venue */}
          <Field label={t('evt.venueLbl')}>
            <input className={INPUT} value={form.venue} onChange={e => set('venue', e.target.value)} placeholder="ex: Institut Français de Yaoundé" />
          </Field>

          {/* City + Neighborhood */}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('evt.cityLbl')}>
              <RefPicker kind="city" className={INPUT} value={form.city} other={cityOther}
                onChange={(v, o) => { set('city', v); setCityOther(o) }} />
            </Field>
            <Field label={t('evt.neighborLbl')}>
              <input className={INPUT} value={form.neighborhood} onChange={e => set('neighborhood', e.target.value)} placeholder={t('evt.neighborPh')} />
            </Field>
          </div>

          {/* Category */}
          <Field label={t('evt.catLbl')}>
            <RefPicker kind="event_category" className={INPUT} value={form.category} other={categoryOther}
              onChange={(v, o) => { set('category', v); setCategoryOther(o) }} />
          </Field>

          {/* Single-price or multi-tier mode. The toggle preserves the
              existing flow for organizers who just want a flat price;
              tier mode swaps in a dynamic list with templates. */}
          <div className="flex items-center justify-between bg-surface-muted border border-divider rounded-xl px-3 py-2.5">
            <label className="flex items-center gap-3 cursor-pointer text-sm flex-1">
              <input
                type="checkbox"
                checked={useTiers}
                onChange={e => setUseTiers(e.target.checked)}
              />
              <span className="text-ink-primary">
                🎫 {bi('Plusieurs catégories de billets', 'Multiple ticket categories')}
              </span>
            </label>
          </div>

          {!useTiers && (
            <Field label={t('evt.priceLbl')}>
              <input
                type="number"
                min="0"
                className={INPUT}
                value={form.price}
                onChange={e => set('price', e.target.value)}
                placeholder="0"
              />
            </Field>
          )}

          {useTiers && (
            <div className="space-y-3">
              {/* Template presets — quick-fill */}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => applyTemplate('standard')}
                  className="text-xs font-semibold px-3 py-1.5 rounded-full bg-surface-muted text-ink-secondary hover:bg-divider">
                  🎉 {bi('Standard', 'Standard')}
                </button>
                <button type="button" onClick={() => applyTemplate('family')}
                  className="text-xs font-semibold px-3 py-1.5 rounded-full bg-surface-muted text-ink-secondary hover:bg-divider">
                  👶 {bi('Famille', 'Family')}
                </button>
                <button type="button" onClick={() => applyTemplate('vip')}
                  className="text-xs font-semibold px-3 py-1.5 rounded-full bg-surface-muted text-ink-secondary hover:bg-divider">
                  ⭐ {bi('VIP', 'VIP')}
                </button>
              </div>

              {/* Dynamic tier rows */}
              {tiers.map((tier, idx) => (
                <div key={idx} className="bg-white border border-divider rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-ink-secondary">
                      🎫 {bi('Tarif', 'Tier')} #{idx + 1}
                    </p>
                    {tiers.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeTier(idx)}
                        className="text-xs text-rose-600 hover:text-rose-700"
                      >
                        🗑️ {bi('Retirer', 'Remove')}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      className={INPUT}
                      value={tier.name}
                      onChange={e => updateTier(idx, 'name', e.target.value)}
                      placeholder={bi('Nom (FR)', 'Name (FR)')}
                    />
                    <input
                      type="text"
                      className={INPUT}
                      value={tier.name_en}
                      onChange={e => updateTier(idx, 'name_en', e.target.value)}
                      placeholder={bi('Nom (EN, optionnel)', 'Name (EN, optional)')}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      min="0"
                      className={INPUT}
                      value={tier.price}
                      onChange={e => updateTier(idx, 'price', e.target.value)}
                      placeholder={bi('Prix FCFA (0 = gratuit)', 'Price FCFA (0 = free)')}
                    />
                    <input
                      type="number"
                      min="0"
                      className={INPUT}
                      value={tier.max_quantity}
                      onChange={e => updateTier(idx, 'max_quantity', e.target.value)}
                      placeholder={dayCount > 1
                        ? bi('Max par jour (0 = illimité)', 'Max per day (0 = unlimited)')
                        : bi('Quantité (0 = illimité)', 'Qty (0 = unlimited)')}
                    />
                  </div>
                  <input
                    type="text"
                    className={INPUT}
                    value={tier.description}
                    onChange={e => updateTier(idx, 'description', e.target.value)}
                    placeholder={bi('Description (optionnel)', 'Description (optional)')}
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={addTier}
                className="w-full text-sm font-semibold text-brand hover:text-brand-dark py-2 border border-dashed border-brand-light rounded-xl"
              >
                ➕ {bi('Ajouter un tarif', 'Add tier')}
              </button>
            </div>
          )}

          {/* Capacity + online payment toggle. Capacity 0 means unlimited
              (matches API behaviour). Online payment toggle is hidden for
              free events; the insert forces it off anyway. */}
          <div className="grid grid-cols-2 gap-3">
            {/* Capacity is per day. With tiers it is the sum of their max
                per day, shown read-only (the server computes the same). */}
            <Field label={dayCount > 1
              ? bi('Places par jour (0 = illimité)', 'Seats per day (0 = unlimited)')
              : bi('Capacité (0 = illimité)', 'Capacity (0 = unlimited)')}>
              {useTiers ? (
                <div className={`${INPUT} bg-surface-muted text-ink-secondary`} aria-readonly="true">
                  {tierCapacity > 0 ? tierCapacity : bi('Illimité', 'Unlimited')}
                  <span className="block text-[10px] text-ink-tertiary">{bi('Somme des tarifs', 'Sum of the tiers')}</span>
                </div>
              ) : (
                <input
                  type="number"
                  min="0"
                  className={INPUT}
                  value={form.max_tickets}
                  onChange={e => set('max_tickets', e.target.value)}
                  placeholder="0"
                />
              )}
              {capacityTotalLine(dayCount, perDayCapacity, locale) && (
                <p className="text-[11px] text-ink-tertiary mt-1">{capacityTotalLine(dayCount, perDayCapacity, locale)}</p>
              )}
            </Field>
            <Field label={bi('Réservations', 'Reservations')}>
              <div className="text-xs text-ink-tertiary pt-2">
                {bi(
                  'Les invités pourront réserver via Tchop & Ndjoka.',
                  'Guests can reserve via Tchop & Ndjoka.',
                )}
              </div>
            </Field>
          </div>

          {/* Payment mode selector — paid events only. Free events stay
              reservation_only (nothing to pay for). */}
          {form.price && parseFloat(form.price) > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-ink-secondary">
                💳 {bi('Mode de paiement', 'Payment mode')}
              </p>
              {([
                ['reservation_only', bi('📋 Réservation uniquement', '📋 Reservation only'),       bi('Paiement sur place.', 'Pay at the door.')],
                ['payment_only',     bi('💰 Paiement en ligne uniquement', '💰 Online payment only'), bi('Le client doit payer le billet en ligne.', 'Customer must pay for the ticket online.')],
                ['both',             bi('💰📋 Les deux', '💰📋 Both'),                                bi('Le client choisit: payer ou réserver.', 'Customer chooses: pay or reserve.')],
              ] as [PaymentMode, string, string][]).map(([value, title, sub]) => (
                <label
                  key={value}
                  className={`flex items-start gap-3 rounded-xl border-2 px-3 py-3 text-sm cursor-pointer transition-colors ${
                    form.payment_mode === value ? 'border-brand bg-brand-light' : 'border-divider bg-surface hover:border-brand-badge'
                  }`}
                >
                  <input
                    type="radio"
                    name="payment_mode"
                    checked={form.payment_mode === value}
                    onChange={() => set('payment_mode', value)}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <strong className="block text-ink-primary">{title}</strong>
                    <span className="text-xs text-ink-secondary">{sub}</span>
                  </span>
                </label>
              ))}

              {/* WhatsApp payment — separate toggle, only when online payment
                  is offered (payment_only or both). Default off. */}
              {canPayOnline(form.payment_mode) && (
                <label className="flex items-start gap-3 bg-surface border border-divider rounded-xl px-3 py-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!form.whatsapp_payment_enabled}
                    onChange={e => set('whatsapp_payment_enabled', e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <strong className="block text-ink-primary">
                      💬 {bi('Paiement WhatsApp', 'WhatsApp Payment')}
                    </strong>
                    <span className="text-xs text-ink-secondary">
                      {bi(
                        'Permettre le paiement Mobile Money via WhatsApp. Désactivé: WhatsApp = réservation uniquement.',
                        'Allow Mobile Money payment via WhatsApp. Off: WhatsApp = reservation only.',
                      )}
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          {/* Manual approval toggle — off by default keeps the existing
              auto-confirm behaviour for events that don't opt in. */}
          <label className="flex items-start gap-3 bg-surface-muted border border-divider rounded-xl px-3 py-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={!!form.requires_confirmation}
              onChange={e => set('requires_confirmation', e.target.checked)}
              className="mt-0.5"
            />
            <span className="flex-1 text-ink-primary">
              <strong className="block">
                📋 {bi('Approbation manuelle des réservations', 'Manual reservation approval')}
              </strong>
              <span className="text-xs text-ink-secondary">
                {bi(
                  'Chaque réservation reste en attente jusqu\'à votre confirmation.',
                  'Each reservation stays pending until you confirm it.',
                )}
              </span>
            </span>
          </label>

          {/* Organizer */}
          <Field label={t('evt.organizerLbl')}>
            <input className={INPUT} value={form.organizer_name} onChange={e => set('organizer_name', e.target.value)} placeholder="ex: Association Culturelle Mboa" />
          </Field>

          {/* Contact numbers (C3): the account phone, and an optional extra
              number that also gets this event's notifications (pre-filled
              from the Pro profile; typed any way, normalised by the server). */}
          <Field label={t('evt.whatsappLbl')}>
            <p className={`${INPUT} bg-surface-muted text-ink-secondary`}>{me?.phone ? formatPhoneDisplay(me.phone) : '—'}</p>
            <span className="block text-[11px] text-ink-tertiary mt-1">{bi('Le numéro de votre compte.', 'Your account number.')}</span>
          </Field>
          <Field label={bi('Autre numéro pour les notifications (facultatif)', 'Extra notification number (optional)')}>
            <input className={INPUT} value={form.notify_phone} inputMode="tel" placeholder="6 70 00 00 00"
              onChange={e => set('notify_phone', e.target.value)} />
            <span className="block text-[11px] text-ink-tertiary mt-1">
              {bi('Reçoit aussi les réservations, validations et annulations.', 'Also gets bookings, approvals and cancellations.')}
            </span>
          </Field>

          {error && (
            <p className="text-danger text-sm bg-brand-light px-4 py-3 rounded-xl">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-3.5 rounded-2xl font-bold text-sm transition-colors"
          >
            {submitting ? t('evt.submitting') : t('evt.submitFormBtn')}
          </button>

        </form>
      </div>
    </div>
  )
}

const LABEL = 'block text-sm font-semibold text-ink-primary mb-1'
const INPUT  = 'w-full border border-divider rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-light bg-white'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={LABEL}>{label}</label>
      {children}
    </div>
  )
}
