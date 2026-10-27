'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import TopNav from '@/components/TopNav'
import { useBi, useLanguage, pickBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'
import { useCity } from '@/lib/cityContext'
import { proLoginHref } from '@/lib/lastPhone'
import { formatPhoneDisplay } from '@/lib/phoneValidation'
import { RESTAURANT_CITIES, FOOD_TYPES } from '@/lib/restaurantSignup'

const INPUT = 'w-full bg-surface-muted border border-divider rounded-xl px-3 py-2.5 text-sm text-ink-primary outline-none focus:border-brand'
const BOT_NUMBER = (process.env.NEXT_PUBLIC_WHATSAPP_BOT_NUMBER ?? '').replace(/\D/g, '')

// /pro/restaurants/new — "Ajouter un restaurant" (C3). Logged-in only: the
// account becomes the owner and its phone the restaurant's WhatsApp. Same
// result as the WhatsApp signup (POST /api/restaurants/submit). Logged out →
// /login (Pro path) and straight back here.
export default function AddRestaurantPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const { city: browsingCity } = useCity()
  const { loading, canEnterPro, sessionRole, effectiveMode, setMode } = useMode()
  const [phone, setPhone] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', city: '', neighborhood: '', cuisine_type: '' })
  const [photo, setPhoto] = useState<File | null>(null)
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null)
  const [posState, setPosState] = useState<'idle' | 'asking' | 'ok' | 'denied'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [existingId, setExistingId] = useState<string | null>(null)
  const [done, setDone] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    if (loading) return
    if (!sessionRole) { window.location.replace(proLoginHref('/pro/restaurants/new')); return }
    if (canEnterPro && effectiveMode !== 'pro') setMode('pro')
  }, [loading, sessionRole, canEnterPro, effectiveMode, setMode])

  useEffect(() => {
    if (!canEnterPro) return
    fetch('/api/auth/me', { cache: 'no-store' }).then(r => r.json()).then(d => setPhone(d?.user?.phone ?? null)).catch(() => {})
    setForm(f => f.city ? f : { ...f, city: RESTAURANT_CITIES.some(c => c.name === browsingCity) ? browsingCity : 'Yaoundé' })
  }, [canEnterPro, browsingCity])

  const set = (k: keyof typeof form, v: string) => { setForm(f => ({ ...f, [k]: v })); setError(null) }

  function askPosition() {
    if (!('geolocation' in navigator)) { setPosState('denied'); return }
    setPosState('asking')
    navigator.geolocation.getCurrentPosition(
      p => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude }); setPosState('ok') },
      () => setPosState('denied'),
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null); setExistingId(null)
    try {
      let image_url: string | null = null
      if (photo) {
        const fd = new FormData()
        fd.append('file', photo)
        fd.append('kind', 'restaurant_hero')
        fd.append('bucket', 'restaurant-images')
        fd.append('pathPrefix', 'restaurants')
        const up = await fetch('/api/upload/image', { method: 'POST', body: fd })
        if (up.ok) image_url = (await up.json())?.url ?? null
      }
      const r = await fetch('/api/restaurants/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, image_url, ...(pos ?? {}) }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setError(pickBi(d.error ?? 'Erreur / Error', locale))
        if (d.restaurant_id) setExistingId(d.restaurant_id)
        return
      }
      setDone(d.restaurant)
    } catch {
      setError(bi('Erreur réseau — réessayez.', 'Network error — please try again.'))
    } finally {
      setBusy(false)
    }
  }

  const ready = form.name.trim().length >= 2 && form.city && form.neighborhood.trim().length >= 2 && form.cuisine_type

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-xl mx-auto px-4 py-6 pb-28 md:pb-10">
        {loading || !sessionRole ? (
          <div className="py-20 text-center text-4xl animate-bounce" aria-hidden="true">🏪</div>
        ) : !canEnterPro ? (
          <p className="bg-white rounded-2xl shadow-sm p-6 text-center text-sm text-ink-secondary">
            {bi('Réservé aux comptes clients.', 'For customer accounts only.')}
          </p>
        ) : done ? (
          <div className="bg-white rounded-2xl shadow-sm p-6 text-center">
            <p className="text-5xl mb-3" aria-hidden="true">✅</p>
            <h1 className="text-lg font-bold text-ink-primary">{bi(`${done.name} est enregistré !`, `${done.name} is registered!`)}</h1>
            <p className="text-sm text-ink-secondary mt-2 mb-5">
              {bi('En attente de validation par notre équipe (24 h). Vous recevrez un message sur WhatsApp.', 'Waiting for approval by our team (24 h). You\'ll get a WhatsApp message.')}
            </p>
            <Link href="/pro/restaurants" className="inline-block bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm">
              🏪 {bi('Mes restaurants', 'My restaurants')}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
            <div>
              <h1 className="text-xl font-bold text-ink-primary">🏪 {bi('Ajouter un restaurant', 'Add a restaurant')}</h1>
              <p className="text-xs text-ink-tertiary mt-1">
                {bi('Recevez commandes et réservations sur WhatsApp, payées par Mobile Money.', 'Get orders and bookings on WhatsApp, paid by Mobile Money.')}
              </p>
            </div>

            <label className="block">
              <span className="text-xs font-semibold text-ink-secondary">{bi('Nom du restaurant', 'Restaurant name')}</span>
              <input className={`${INPUT} mt-1`} value={form.name} maxLength={120} onChange={e => set('name', e.target.value)} />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-semibold text-ink-secondary">{bi('Ville', 'City')}</span>
                <select className={`${INPUT} mt-1`} value={form.city} onChange={e => { set('city', e.target.value); setPos(null); setPosState('idle') }}>
                  {RESTAURANT_CITIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-ink-secondary">{bi('Quartier', 'Neighbourhood')}</span>
                <input className={`${INPUT} mt-1`} value={form.neighborhood} maxLength={80} placeholder={bi('ex : Bastos', 'e.g. Bastos')}
                  onChange={e => set('neighborhood', e.target.value)} />
              </label>
            </div>

            <label className="block">
              <span className="text-xs font-semibold text-ink-secondary">{bi('Type de cuisine', 'Food type')}</span>
              <select className={`${INPUT} mt-1`} value={form.cuisine_type} onChange={e => set('cuisine_type', e.target.value)}>
                <option value="">{bi('Choisir…', 'Choose…')}</option>
                {FOOD_TYPES.map(f => <option key={f.value} value={f.value}>{locale === 'en' ? f.en : f.fr}</option>)}
              </select>
            </label>

            <div>
              <span className="text-xs font-semibold text-ink-secondary">{bi('Position sur la carte', 'Map position')}</span>
              <div className="mt-1 flex items-center gap-2 flex-wrap">
                <button type="button" onClick={askPosition} disabled={posState === 'asking'}
                  className="text-xs font-semibold px-3 py-2 rounded-xl border border-divider bg-white hover:bg-surface-muted disabled:opacity-50">
                  📍 {posState === 'asking' ? '…' : bi('Utiliser ma position actuelle', 'Use my current location')}
                </button>
                <span className="text-[11px] text-ink-tertiary">
                  {posState === 'ok' ? bi('Position enregistrée ✓', 'Location saved ✓')
                    : posState === 'denied' ? bi('Position indisponible — centre-ville utilisé.', 'Location unavailable — city centre used.')
                      : bi(`Sinon : centre de ${form.city || 'la ville'}.`, `Otherwise: centre of ${form.city || 'the city'}.`)}
                </span>
              </div>
            </div>

            <label className="block">
              <span className="text-xs font-semibold text-ink-secondary">{bi('Photo (facultatif)', 'Photo (optional)')}</span>
              <input type="file" accept="image/*" className="mt-1 block w-full text-xs" onChange={e => setPhoto(e.target.files?.[0] ?? null)} />
            </label>

            <div>
              <span className="text-xs font-semibold text-ink-secondary">{bi('Numéro WhatsApp du restaurant', 'Restaurant WhatsApp number')}</span>
              <p className="mt-1 text-sm text-ink-primary bg-surface-muted rounded-xl px-3 py-2.5">{phone ? formatPhoneDisplay(phone) : '—'}</p>
              <span className="block text-[11px] text-ink-tertiary mt-1">{bi('Celui de votre compte : les commandes arrivent ici.', 'Your account number: orders arrive here.')}</span>
            </div>

            {error && (
              <p className="text-xs text-danger" role="alert">
                {error}{' '}
                {existingId && <Link href="/pro/restaurants" className="underline font-semibold">{bi('Voir mes restaurants', 'See my restaurants')}</Link>}
              </p>
            )}

            <button type="submit" disabled={busy || !ready}
              className="w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white py-3 rounded-xl text-sm font-bold transition-colors">
              {busy ? '…' : bi('Envoyer pour validation', 'Submit for approval')}
            </button>

            {BOT_NUMBER && (
              <p className="text-[11px] text-ink-tertiary text-center">
                {bi('Vous préférez WhatsApp ? Envoyez « restaurant » au ', 'Prefer WhatsApp? Send "restaurant" to ')}
                <a href={`https://wa.me/${BOT_NUMBER}?text=restaurant`} className="underline">+{BOT_NUMBER}</a>
              </p>
            )}
          </form>
        )}
      </main>
    </div>
  )
}
