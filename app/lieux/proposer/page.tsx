'use client'
import RefPicker, { OTHER, pickerBody } from '@/components/RefPicker'
import { useRefData } from '@/lib/useRefData'

// /lieux/proposer — "+ Ajouter → Un lieu à visiter" (I4). Any logged-in
// user, Client or Pro mode. The proposal waits for admin approval; without a
// photo the generated cover shows.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import TopNav from '@/components/TopNav'
import { useBi } from '@/lib/languageContext'
import { useCity } from '@/lib/cityContext'
import { loginHref } from '@/lib/lastPhone'

const input = 'w-full border border-divider rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/40'

export default function ProposePlacePage() {
  const bi = useBi()
  useRefData()
  const { city: currentCity } = useCity()
  const fileRef = useRef<HTMLInputElement>(null)
  const [logged, setLogged] = useState<boolean | null>(null)
  const [f, setF] = useState({ title_fr: '', city: '', area: '', category: '', description_fr: '', tip_fr: '', hours: '', price: '', official_link: '' })
  const [cityOther, setCityOther] = useState('')
  const [categoryOther, setCategoryOther] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' }).then(r => r.json())
      .then(d => setLogged(d?.user?.role === 'customer')).catch(() => setLogged(false))
  }, [])
  useEffect(() => { setF(x => x.city ? x : { ...x, city: currentCity }) }, [currentCity])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF(x => ({ ...x, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!f.title_fr.trim()) return setError(bi('Le nom du lieu est requis.', 'The place name is required.'))
    if (!f.category || (f.category === OTHER && !categoryOther.trim())) return setError(bi('Choisissez une catégorie.', 'Pick a category.'))
    if (f.city === OTHER && cityOther.trim().length < 2) return setError(bi('Indiquez la ville.', 'Enter the city.'))
    setBusy(true)
    try {
      let cover_url = ''
      if (photo) {
        const fd = new FormData()
        fd.append('file', photo); fd.append('kind', 'restaurant_hero'); fd.append('pathPrefix', 'places')
        const r = await fetch('/api/upload/image', { method: 'POST', body: fd })
        const j = r.ok ? await r.json().catch(() => null) : null
        if (typeof j?.url !== 'string') { setError(bi('L\'envoi de la photo a échoué, réessayez.', 'The photo upload failed, please try again.')); return }
        cover_url = j.url
      }
      const r = await fetch('/api/places', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...f, ...pickerBody('city', f.city, cityOther), ...pickerBody('category', f.category, categoryOther), ...(cover_url ? { cover_url } : {}) }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setError(j?.error ?? bi('Erreur, réessayez.', 'Error, please try again.')); return }
      setDone(true)
    } catch {
      setError(bi('Connexion perdue, réessayez.', 'Connection lost, please try again.'))
    } finally { setBusy(false) }
  }

  if (logged === null) return <div className="min-h-screen bg-surface"><TopNav /></div>
  if (!logged) {
    return (
      <div className="min-h-screen bg-surface"><TopNav />
        <div className="max-w-md mx-auto px-6 pt-16 text-center">
          <h1 className="text-xl font-bold text-ink-primary mb-2">{bi('Connectez-vous pour proposer un lieu', 'Log in to suggest a place')}</h1>
          <p className="text-sm text-ink-secondary mb-6">{bi('Un code par WhatsApp suffit.', 'One WhatsApp code is enough.')}</p>
          <Link href={loginHref('/lieux/proposer')} className="bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm">{bi('Se connecter', 'Log in')}</Link>
        </div>
      </div>
    )
  }
  if (done) {
    return (
      <div className="min-h-screen bg-surface"><TopNav />
        <div className="max-w-md mx-auto px-6 pt-16 text-center">
          <p className="text-4xl mb-3">🙏</p>
          <h1 className="text-xl font-bold text-ink-primary mb-2">{bi('Merci ! Lieu envoyé', 'Thank you! Place sent')}</h1>
          <p className="text-sm text-ink-secondary mb-6">{bi('Notre équipe le vérifie avant de le publier.', 'Our team checks it before publishing.')}</p>
          <Link href="/lieux" className="bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm">{bi('Voir « À visiter »', 'See "To visit"')}</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-xl mx-auto px-4 pt-5 pb-28 md:pb-12">
        <h1 className="text-2xl font-black text-ink-primary">{bi('Proposer un lieu à visiter', 'Suggest a place to visit')}</h1>
        <p className="text-sm text-ink-secondary mt-1">{bi('Musée, monument, marché, point de vue… Validé par notre équipe avant publication.', 'Museum, monument, market, viewpoint… Checked by our team before publishing.')}</p>
        <form onSubmit={submit} className="mt-5 space-y-4">
          <label className="block"><span className="text-sm font-semibold">{bi('Nom du lieu', 'Place name')} *</span>
            <input className={input} value={f.title_fr} onChange={set('title_fr')} maxLength={140} required /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="text-sm font-semibold">{bi('Ville', 'City')} *</span>
              <RefPicker kind="city" className={input} value={f.city} other={cityOther} onChange={(v, o) => { setF(x => ({ ...x, city: v })); setCityOther(o) }} /></label>
            <label className="block"><span className="text-sm font-semibold">{bi('Quartier', 'Area')}</span>
              <input className={input} value={f.area} onChange={set('area')} maxLength={80} /></label>
          </div>
          <label className="block"><span className="text-sm font-semibold">{bi('Catégorie', 'Category')} *</span>
            <RefPicker kind="place_category" className={input} value={f.category} other={categoryOther}
              onChange={(v, o) => { setF(x => ({ ...x, category: v })); setCategoryOther(o) }} /></label>
          <label className="block"><span className="text-sm font-semibold">{bi('Description', 'Description')}</span>
            <textarea className={input} rows={4} value={f.description_fr} onChange={set('description_fr')} maxLength={4000} /></label>
          <label className="block"><span className="text-sm font-semibold">{bi('Bon à savoir', 'Good to know')}</span>
            <textarea className={input} rows={2} value={f.tip_fr} onChange={set('tip_fr')} maxLength={1000} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="text-sm font-semibold">{bi('Horaires', 'Hours')}</span>
              <input className={input} value={f.hours} onChange={set('hours')} maxLength={300} /></label>
            <label className="block"><span className="text-sm font-semibold">{bi('Prix', 'Price')}</span>
              <input className={input} value={f.price} onChange={set('price')} maxLength={200} placeholder={bi('Gratuit, 2000 FCFA…', 'Free, 2000 FCFA…')} /></label>
          </div>
          <label className="block"><span className="text-sm font-semibold">{bi('Lien (site, page)', 'Link (site, page)')}</span>
            <input className={input} type="url" inputMode="url" value={f.official_link} onChange={set('official_link')} placeholder="https://" /></label>
          <div>
            <span className="text-sm font-semibold">{bi('Photo (facultative)', 'Photo (optional)')}</span>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => {
              const file = e.target.files?.[0] ?? null
              setPhoto(file); setPreview(file ? URL.createObjectURL(file) : null)
            }} />
            <button type="button" onClick={() => fileRef.current?.click()}
              className="mt-1 w-full relative aspect-[2/1] rounded-xl border-2 border-dashed border-divider bg-white flex items-center justify-center text-sm text-ink-tertiary overflow-hidden">
              {preview ? <Image src={preview} alt="" fill className="object-cover" /> : bi('📷 Ajouter une photo — sinon une couverture est générée', '📷 Add a photo — otherwise a cover is generated')}
            </button>
          </div>
          {error && <p className="text-sm text-red-700 bg-red-50 rounded-xl px-3 py-2">{error}</p>}
          <button type="submit" disabled={busy}
            className="w-full bg-brand hover:bg-brand-dark disabled:opacity-60 text-white font-bold py-3 rounded-xl">
            {busy ? '…' : bi('Envoyer pour validation', 'Send for approval')}
          </button>
        </form>
      </main>
    </div>
  )
}
