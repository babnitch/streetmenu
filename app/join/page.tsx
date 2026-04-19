'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { useLanguage } from '@/lib/languageContext'
import LanguageToggle from '@/components/LanguageToggle'

const CITIES = [
  { label: 'Yaoundé', lat: 3.848, lng: 11.5021 },
  { label: 'Abidjan', lat: 5.36, lng: -4.0083 },
  { label: 'Dakar', lat: 14.6937, lng: -17.4441 },
  { label: 'Lomé', lat: 6.1375, lng: 1.2123 },
]

const CUISINE_TYPES = [
  'Africain traditionnel',
  'Braisé / Grillades',
  'Poulet DG / Poulet braisé',
  'Cuisine camerounaise',
  'Cuisine ivoirienne',
  'Cuisine sénégalaise',
  'Cuisine togolaise',
  'Fast Food',
  'Sandwichs & Burgers',
  'Fruits de mer',
  'Végétarien',
  'Autre',
]

const INPUT = 'w-full border border-divider rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-light bg-white'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-ink-secondary font-medium mb-1.5">{label}</label>
      {children}
    </div>
  )
}

export default function JoinPage() {
  const { t } = useLanguage()
  const [form, setForm] = useState({
    name: '',
    owner_name: '',
    whatsapp: '',
    city: '',
    neighborhood: '',
    cuisine_type: '',
  })
  const [coverPhoto, setCoverPhoto] = useState<File | null>(null)
  const [coverPreview, setCoverPreview] = useState('')
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  const set = (field: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(f => ({ ...f, [field]: e.target.value }))

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setCoverPhoto(file)
    setCoverPreview(URL.createObjectURL(file))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const { name, owner_name, whatsapp, city, neighborhood, cuisine_type } = form
    if (!name || !owner_name || !whatsapp || !city || !neighborhood || !cuisine_type) {
      setError(t('join.errorRequired'))
      return
    }
    setError('')
    setSubmitting(true)

    let logo_url = ''
    if (coverPhoto) {
      setUploading(true)
      const path = `restaurants/${Date.now()}-${coverPhoto.name.replace(/\s+/g, '-')}`
      const { error: uploadError } = await supabase.storage.from('photos').upload(path, coverPhoto)
      if (!uploadError) {
        const { data } = supabase.storage.from('photos').getPublicUrl(path)
        logo_url = data.publicUrl
      }
      setUploading(false)
    }

    const cityData = CITIES.find(c => c.label === city)

    const { error: insertError } = await supabase.from('restaurants').insert({
      name: name.trim(),
      owner_name: owner_name.trim(),
      whatsapp: whatsapp.trim(),
      city,
      neighborhood: neighborhood.trim(),
      address: neighborhood.trim(),
      cuisine_type,
      description: cuisine_type,
      lat: cityData?.lat ?? 0,
      lng: cityData?.lng ?? 0,
      logo_url,
      is_open: false,
      is_active: false,
    })

    setSubmitting(false)

    if (insertError) {
      setError(t('join.errorServer'))
      console.error(insertError)
    } else {
      setSuccess(true)
    }
  }

  if (success) {
    return (
      <div className="min-h-screen bg-brand-light flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl shadow-xl p-10 max-w-md w-full text-center">
          <div className="text-6xl mb-5">🎉</div>
          <h2 className="text-2xl font-bold text-ink-primary mb-2">{t('join.successTitle')}</h2>
          <p className="text-ink-secondary mb-1 font-medium">{t('join.successSub')}</p>
          <p className="text-sm text-ink-tertiary mb-8">{t('join.successSub2')}</p>
          <Link
            href="/"
            className="inline-block bg-brand hover:bg-brand-dark text-white px-8 py-3 rounded-xl font-semibold transition-colors"
          >
            {t('join.backToMap')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-brand-light">
      {/* Nav */}
      <div className="bg-white border-b border-brand-light sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="bg-brand text-white font-black text-xs px-1.5 py-1 rounded-lg tracking-tight leading-none">NT</span>
            <span className="font-bold text-ink-primary text-base">Ndjoka &amp; Tchop</span>
          </Link>
          <div className="flex items-center gap-3">
            <LanguageToggle />
            <Link href="/" className="text-sm text-ink-secondary hover:text-ink-primary transition-colors">
              {t('join.back')}
            </Link>
          </div>
        </div>
      </div>

      <div className="max-w-xl mx-auto px-4 py-10 pb-16">
        {/* Hero */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-brand-light rounded-3xl text-4xl mb-5">
            🏪
          </div>
          <h1 className="text-3xl font-bold text-ink-primary mb-2 leading-tight">
            {t('join.headline1')}<br />{t('join.headline2')}
          </h1>
          <p className="text-ink-secondary text-base font-medium">
            {t('join.subHeadline')}
          </p>
          <p className="text-sm text-ink-tertiary mt-2 max-w-sm mx-auto">
            {t('join.sub2')}
          </p>
        </div>

        {/* Benefits pills */}
        <div className="flex flex-wrap justify-center gap-2 mb-8">
          {(['join.pill1', 'join.pill2', 'join.pill3', 'join.pill4'] as const).map(key => (
            <span key={key} className="bg-white border border-brand-light text-ink-secondary text-xs font-medium px-3 py-1.5 rounded-full shadow-sm">
              {t(key)}
            </span>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-3xl shadow-sm border border-brand-light p-6 space-y-5">
          <Field label={t('join.nameLbl')}>
            <input
              value={form.name}
              onChange={set('name')}
              placeholder="ex: Mama Afrika Grill"
              className={INPUT}
              required
            />
          </Field>

          <Field label={`${t('join.ownerLbl')}  ·  ${t('join.ownerSub')}`}>
            <input
              value={form.owner_name}
              onChange={set('owner_name')}
              placeholder="ex: Marie Kouassi"
              className={INPUT}
              required
            />
          </Field>

          <Field label={t('join.whatsappLbl')}>
            <input
              value={form.whatsapp}
              onChange={set('whatsapp')}
              placeholder="+237 6XX XXX XXX"
              className={INPUT}
              type="tel"
              required
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label={`${t('join.cityLbl')}  ·  ${t('join.citySub')}`}>
              <select value={form.city} onChange={set('city')} className={INPUT} required>
                <option value="">{t('join.cityPh')}</option>
                {CITIES.map(c => (
                  <option key={c.label} value={c.label}>{c.label}</option>
                ))}
              </select>
            </Field>

            <Field label={`${t('join.neighborLbl')}  ·  ${t('join.neighborSub')}`}>
              <input
                value={form.neighborhood}
                onChange={set('neighborhood')}
                placeholder={t('join.neighborPh')}
                className={INPUT}
                required
              />
            </Field>
          </div>

          <Field label={`${t('join.cuisineLbl')}  ·  ${t('join.cuisineSub')}`}>
            <select value={form.cuisine_type} onChange={set('cuisine_type')} className={INPUT} required>
              <option value="">{t('join.cuisinePh')}</option>
              {CUISINE_TYPES.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>

          <Field label={`${t('join.photoLbl')}  ·  ${t('join.photoSub')}`}>
            <label className="block w-full cursor-pointer">
              {coverPreview ? (
                <div className="relative w-full h-44 rounded-xl overflow-hidden group">
                  <Image src={coverPreview} alt="Aperçu" fill className="object-cover" />
                  <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-xl">
                    <span className="text-white text-sm font-semibold">📷 {t('join.changePhoto')}</span>
                  </div>
                </div>
              ) : (
                <div className="border-2 border-dashed border-brand-badge rounded-xl p-8 text-center hover:border-brand transition-colors">
                  <div className="text-3xl mb-2">📷</div>
                  <p className="text-sm text-ink-secondary font-medium">{t('join.photoHint')}</p>
                  <p className="text-xs text-ink-tertiary mt-1">{t('join.photoSize')}</p>
                </div>
              )}
              <input type="file" accept="image/*" onChange={handlePhotoChange} className="hidden" />
            </label>
          </Field>

          {error && (
            <p className="text-sm text-danger bg-brand-light rounded-xl px-4 py-3">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting || uploading}
            className="w-full bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-3.5 rounded-xl font-bold text-base transition-colors"
          >
            {submitting || uploading ? t('join.submitting') : t('join.submitBtn')}
          </button>

          <p className="text-center text-xs text-ink-tertiary leading-relaxed">
            {t('join.terms')}
          </p>
        </form>
      </div>
    </div>
  )
}
