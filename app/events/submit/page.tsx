'use client'

export const dynamic = 'force-dynamic'

import { useState, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { useLanguage } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'

const CITIES = ['Yaoundé', 'Abidjan', 'Dakar', 'Lomé']

const CATEGORIES = [
  'Music', 'Food', 'Sport', 'Art', 'Nightlife', 'Business', 'BT / Club', 'Autre',
]


export default function SubmitEventPage() {
  const { t } = useLanguage()
  const fileInputRef = useRef<HTMLInputElement>(null)

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
  })
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  function set(field: string, value: string) {
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

    const { error: insertErr } = await supabase.from('events').insert({
      title: form.title,
      description: form.description || null,
      date: form.date,
      time: form.time || null,
      venue: form.venue || null,
      city: form.city,
      neighborhood: form.neighborhood || null,
      category: form.category,
      price: form.price ? parseFloat(form.price) : null,
      cover_photo: cover_photo || null,
      whatsapp: form.whatsapp,
      organizer_name: form.organizer_name,
      is_active: false,
    })

    setSubmitting(false)

    if (insertErr) {
      setError(t('evt.errorServer'))
      return
    }

    setSuccess(true)
  }

  if (success) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-4 text-center" style={{ background: '#fffaf5' }}>
        <div className="w-20 h-20 bg-green-100 rounded-3xl flex items-center justify-center text-4xl mb-5">✅</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">{t('evt.successTitle')}</h1>
        <p className="text-gray-500 text-sm mb-6 max-w-xs">{t('evt.successSub')}</p>
        <Link
          href="/events"
          className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors"
        >
          {t('evt.backToEvents')}
        </Link>
      </div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: '#fffaf5' }}>
      <TopNav />
      <div className="max-w-xl mx-auto px-4 py-6">

        {/* Title */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">{t('evt.submitTitle')}</h1>
          <p className="text-sm text-gray-400 mt-1">{t('evt.submitSub')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Cover photo */}
          <div>
            <label className={LABEL}>{t('evt.photoLbl')}</label>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="relative h-40 bg-orange-50 border-2 border-dashed border-orange-200 rounded-2xl flex items-center justify-center cursor-pointer hover:border-orange-400 transition-colors overflow-hidden"
            >
              {photoPreview ? (
                <>
                  <Image src={photoPreview} alt="preview" fill className="object-cover rounded-2xl" />
                  <span className="absolute bottom-2 right-2 bg-white/90 text-xs text-gray-600 px-2 py-1 rounded-lg backdrop-blur-sm">
                    {t('evt.changePhoto')}
                  </span>
                </>
              ) : (
                <div className="text-center">
                  <p className="text-gray-400 text-sm">{t('evt.photoHint')}</p>
                  <p className="text-gray-300 text-xs mt-1">{t('evt.photoSize')}</p>
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
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
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

          {/* Organizer */}
          <Field label={t('evt.organizerLbl')}>
            <input className={INPUT} value={form.organizer_name} onChange={e => set('organizer_name', e.target.value)} placeholder="ex: Association Culturelle Mboa" />
          </Field>

          {/* WhatsApp */}
          <Field label={t('evt.whatsappLbl')}>
            <input
              type="tel"
              className={INPUT}
              value={form.whatsapp}
              onChange={e => set('whatsapp', e.target.value)}
              placeholder={t('evt.whatsappPh')}
            />
          </Field>

          {error && (
            <p className="text-red-500 text-sm bg-red-50 px-4 py-3 rounded-xl">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors"
          >
            {submitting ? t('evt.submitting') : t('evt.submitFormBtn')}
          </button>

        </form>
      </div>
    </div>
  )
}

const LABEL = 'block text-sm font-semibold text-gray-700 mb-1'
const INPUT  = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 bg-white'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={LABEL}>{label}</label>
      {children}
    </div>
  )
}
