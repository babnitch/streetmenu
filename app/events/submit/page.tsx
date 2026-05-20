'use client'

export const dynamic = 'force-dynamic'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { useLanguage, useBi } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'
import PhoneInput from '@/components/PhoneInput'
import { getCountryFromCity } from '@/lib/phoneValidation'

const CITIES = ['Yaoundé', 'Abidjan', 'Dakar', 'Lomé']

const CATEGORIES = [
  'Music', 'Food', 'Sport', 'Enfants', 'Art', 'Nightlife', 'Business', 'BT / Club', 'Autre',
]

// Same emoji-prefix-on-render convention as app/events/page.tsx.
function categoryLabel(cat: string): string {
  return cat === 'Enfants' ? '👶 Enfants' : cat
}


interface SessionUser { id: string; name: string; phone: string; role: string }

export default function SubmitEventPage() {
  const { t } = useLanguage()
  const bi = useBi()
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

  // Submission outcome — auto_approved sees a different success screen
  // than admin-pending.
  const [autoApproved, setAutoApproved] = useState(false)

  const [form, setForm] = useState({
    title: '',
    description: '',
    date: '',
    time: '',
    venue: '',
    city: '',
    neighborhood: '',
    category: '',
    price: '',
    whatsapp: '',
    organizer_name: '',
    max_tickets: '',
    payment_enabled: false,
  })
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  function set(field: string, value: string | boolean) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhoto(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!form.title || !form.date || !form.city || !form.category || !form.whatsapp || !form.organizer_name) {
      setError(t('evt.errorRequired'))
      return
    }

    setSubmitting(true)

    let cover_photo = ''
    if (photo) {
      const ext = photo.name.split('.').pop()
      const path = `events/${Date.now()}.${ext}`
      const { error: uploadErr } = await supabase.storage
        .from('photos')
        .upload(path, photo, { upsert: true })
      if (!uploadErr) {
        const { data: urlData } = supabase.storage.from('photos').getPublicUrl(path)
        cover_photo = urlData.publicUrl
      }
    }

    // Hand off to /api/events/submit so the auto-approve gate + counter
    // increments happen server-side under the trust model. The route also
    // writes audit rows + pings the submitter over WhatsApp.
    const res = await fetch('/api/events/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title:           form.title,
        description:     form.description,
        date:            form.date,
        time:            form.time,
        venue:           form.venue,
        city:            form.city,
        neighborhood:    form.neighborhood,
        category:        form.category,
        ticket_price:    form.price ? parseFloat(form.price) : null,
        max_tickets:     form.max_tickets ? parseInt(form.max_tickets, 10) : 0,
        payment_enabled: !!form.payment_enabled,
        cover_photo:     cover_photo || null,
        whatsapp:        form.whatsapp,
        organizer_name:  form.organizer_name,
      }),
    })
    const data = await res.json()
    setSubmitting(false)
    if (!res.ok) {
      setError(data?.error ?? t('evt.errorServer'))
      return
    }
    setAutoApproved(!!data.auto_approved)
    setSuccess(true)
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
            'La publication d\'événements est réservée aux comptes connectés. C\'est rapide — un code par SMS suffit.',
            'Publishing events requires a logged-in account. Quick — one SMS code is enough.',
          )}
        </p>
        <Link
          href="/account?return=/events/submit"
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
                'Visible immédiatement sur Ndjoka & Tchop.',
                'Live immediately on Ndjoka & Tchop.',
              )
            : bi(
                'Il sera visible après approbation par un admin.',
                'It will be visible after admin approval.',
              )}
        </p>
        <Link
          href="/events"
          className="bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors"
        >
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

          {/* Cover photo */}
          <div>
            <label className={LABEL}>{t('evt.photoLbl')}</label>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="relative h-40 bg-brand-light border-2 border-dashed border-brand-badge rounded-2xl flex items-center justify-center cursor-pointer hover:border-brand transition-colors overflow-hidden"
            >
              {photoPreview ? (
                <>
                  <Image src={photoPreview} alt="preview" fill className="object-cover rounded-2xl" />
                  <span className="absolute bottom-2 right-2 bg-white/90 text-xs text-ink-secondary px-2 py-1 rounded-lg backdrop-blur-sm">
                    {t('evt.changePhoto')}
                  </span>
                </>
              ) : (
                <div className="text-center">
                  <p className="text-ink-tertiary text-sm">{t('evt.photoHint')}</p>
                  <p className="text-ink-tertiary text-xs mt-1">{t('evt.photoSize')}</p>
                </div>
              )}
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

          {/* Date + Time */}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('evt.dateLbl')}>
              <input type="date" className={INPUT} value={form.date} onChange={e => set('date', e.target.value)} />
            </Field>
            <Field label={t('evt.timeLbl')}>
              <input type="time" className={INPUT} value={form.time} onChange={e => set('time', e.target.value)} />
            </Field>
          </div>

          {/* Venue */}
          <Field label={t('evt.venueLbl')}>
            <input className={INPUT} value={form.venue} onChange={e => set('venue', e.target.value)} placeholder="ex: Institut Français de Yaoundé" />
          </Field>

          {/* City + Neighborhood */}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('evt.cityLbl')}>
              <select className={INPUT} value={form.city} onChange={e => set('city', e.target.value)}>
                <option value="">{t('evt.cityPh')}</option>
                {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label={t('evt.neighborLbl')}>
              <input className={INPUT} value={form.neighborhood} onChange={e => set('neighborhood', e.target.value)} placeholder={t('evt.neighborPh')} />
            </Field>
          </div>

          {/* Category + Price */}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('evt.catLbl')}>
              <select className={INPUT} value={form.category} onChange={e => set('category', e.target.value)}>
                <option value="">{t('evt.catPh')}</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}
              </select>
            </Field>
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
          </div>

          {/* Capacity + online payment toggle. Capacity 0 means unlimited
              (matches API behaviour). Online payment toggle is hidden for
              free events; the insert forces it off anyway. */}
          <div className="grid grid-cols-2 gap-3">
            <Field label={bi('Capacité (0 = illimité)', 'Capacity (0 = unlimited)')}>
              <input
                type="number"
                min="0"
                className={INPUT}
                value={form.max_tickets}
                onChange={e => set('max_tickets', e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label={bi('Réservations', 'Reservations')}>
              <div className="text-xs text-ink-tertiary pt-2">
                {bi(
                  'Les invités pourront réserver via Ndjoka & Tchop.',
                  'Guests can reserve via Ndjoka & Tchop.',
                )}
              </div>
            </Field>
          </div>

          {form.price && parseFloat(form.price) > 0 && (
            <label className="flex items-start gap-3 bg-brand-light border border-brand-badge/40 rounded-xl px-3 py-3 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={!!form.payment_enabled}
                onChange={e => set('payment_enabled', e.target.checked)}
                className="mt-0.5"
              />
              <span className="flex-1 text-brand-darker">
                <strong className="block">
                  💰 {bi('Activer le paiement en ligne (PawaPay)', 'Enable online payment (PawaPay)')}
                </strong>
                <span className="text-xs text-brand-dark">
                  {bi(
                    'Sinon, paiement sur place.',
                    'Otherwise, pay at the door.',
                  )}
                </span>
              </span>
            </label>
          )}

          {/* Organizer */}
          <Field label={t('evt.organizerLbl')}>
            <input className={INPUT} value={form.organizer_name} onChange={e => set('organizer_name', e.target.value)} placeholder="ex: Association Culturelle Mboa" />
          </Field>

          {/* WhatsApp */}
          <Field label={t('evt.whatsappLbl')}>
            <PhoneInput
              value={form.whatsapp}
              onChange={(full) => set('whatsapp', full)}
              defaultCountry={form.city ? getCountryFromCity(form.city).iso : undefined}
            />
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
