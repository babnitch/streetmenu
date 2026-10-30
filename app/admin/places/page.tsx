'use client'

export const dynamic = 'force-dynamic'

// Admin → 🏛️ Lieux (I4): every place (published, hidden, proposals waiting),
// create, edit (FR + EN), publish / hide. Admin note and sources stay here —
// never public.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useBi, useLanguage } from '@/lib/languageContext'
import { CITIES } from '@/lib/cityContext'
import { matchesSearch } from '@/lib/textSearch'
import { PLACE_CATEGORIES, placeCategoryLabel } from '@/lib/places'

type Status = 'pending' | 'active' | 'hidden'
interface AdminPlace {
  id: string; status: Status; city: string; area: string | null; category: string
  title_fr: string; title_en: string | null; headline_fr: string | null; headline_en: string | null; description_fr: string | null; description_en: string | null
  tip_fr: string | null; tip_en: string | null; hours: string | null; price: string | null
  official_link: string | null; instagram_url: string | null; facebook_url: string | null; tiktok_url: string | null
  cover_url: string | null; lat: number | null; lng: number | null; admin_note: string | null; sources: string | null
  created_at: string; submitter: { name: string | null; phone: string | null } | null
}
const FIELDS: Array<{ k: keyof AdminPlace; fr: string; en: string; area?: boolean }> = [
  { k: 'title_fr', fr: 'Nom (FR)', en: 'Name (FR)' }, { k: 'title_en', fr: 'Nom (EN)', en: 'Name (EN)' },
  { k: 'headline_fr', fr: 'Accroche (FR)', en: 'Headline (FR)' }, { k: 'headline_en', fr: 'Accroche (EN)', en: 'Headline (EN)' },
  { k: 'area', fr: 'Quartier', en: 'Area' },
  { k: 'description_fr', fr: 'Texte (FR)', en: 'Text (FR)', area: true }, { k: 'description_en', fr: 'Texte (EN)', en: 'Text (EN)', area: true },
  { k: 'tip_fr', fr: 'Bon à savoir (FR)', en: 'Good to know (FR)', area: true }, { k: 'tip_en', fr: 'Bon à savoir (EN)', en: 'Good to know (EN)', area: true },
  { k: 'hours', fr: 'Horaires', en: 'Hours' }, { k: 'price', fr: 'Prix', en: 'Price' },
  { k: 'official_link', fr: 'Site officiel', en: 'Official site' }, { k: 'instagram_url', fr: 'Instagram', en: 'Instagram' },
  { k: 'facebook_url', fr: 'Facebook', en: 'Facebook' }, { k: 'tiktok_url', fr: 'TikTok', en: 'TikTok' },
  { k: 'cover_url', fr: 'Photo (URL, vide = couverture générée)', en: 'Photo (URL, empty = generated cover)' },
  { k: 'lat', fr: 'Latitude', en: 'Latitude' }, { k: 'lng', fr: 'Longitude', en: 'Longitude' },
  { k: 'admin_note', fr: 'Note admin (privée)', en: 'Admin note (private)', area: true },
  { k: 'sources', fr: 'Sources (privées)', en: 'Sources (private)', area: true },
]
const STATUS_PILL: Record<Status, { fr: string; en: string; cls: string }> = {
  pending: { fr: 'À valider', en: 'To approve', cls: 'bg-amber-100 text-amber-800' },
  active:  { fr: 'Publié', en: 'Published', cls: 'bg-green-100 text-green-800' },
  hidden:  { fr: 'Masqué', en: 'Hidden', cls: 'bg-gray-200 text-gray-700' },
}
const input = 'w-full border border-divider rounded-lg px-2.5 py-2 text-sm bg-white'

export default function AdminPlacesPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [places, setPlaces] = useState<AdminPlace[] | null>(null)
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [city, setCity] = useState<string>('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)   // id, or 'new'

  const load = useCallback(() => {
    fetch('/api/admin/places', { cache: 'no-store' }).then(r => r.ok ? r.json() : { places: [] })
      .then(d => setPlaces(d.places ?? [])).catch(() => setPlaces([]))
  }, [])
  useEffect(load, [load])

  const cities = useMemo(() => Array.from(new Set([...CITIES, ...(places ?? []).map(p => p.city)])), [places])
  const counts = useMemo(() => {
    const c = { all: 0, pending: 0, active: 0, hidden: 0 }
    for (const p of places ?? []) { if (city && p.city !== city) continue; c.all++; c[p.status]++ }
    return c
  }, [places, city])
  const shown = (places ?? []).filter(p => (filter === 'all' || p.status === filter) && (!city || p.city === city)
    && matchesSearch(q, [p.title_fr, p.title_en, p.area, p.admin_note]))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-ink-primary">🏛️ {bi('Lieux', 'Places')}</h2>
        <button type="button" onClick={() => setOpen(open === 'new' ? null : 'new')}
          className="bg-brand hover:bg-brand-dark text-white text-sm font-bold px-4 py-2 rounded-full">+ {bi('Nouveau lieu', 'New place')}</button>
      </div>
      {open === 'new' && <PlaceForm onDone={() => { setOpen(null); load() }} />}
      <div className="flex flex-wrap gap-2">
        {(['all', 'pending', 'active', 'hidden'] as const).map(s => (
          <button key={s} type="button" aria-pressed={filter === s} onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${filter === s ? 'bg-ink-primary text-white border-ink-primary' : 'bg-white border-divider text-ink-secondary'}`}>
            {s === 'all' ? bi('Tous', 'All') : bi(STATUS_PILL[s].fr, STATUS_PILL[s].en)} ({counts[s]})
          </button>
        ))}
        <select value={city} onChange={e => setCity(e.target.value)} className="border border-divider rounded-full px-3 py-1.5 text-sm bg-white">
          <option value="">{bi('Toutes les villes', 'All cities')}</option>
          {cities.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <input className={input} value={q} onChange={e => setQ(e.target.value)} placeholder={bi('Rechercher', 'Search')} />
      {places === null ? <p className="text-sm text-ink-tertiary">…</p>
        : shown.length === 0 ? <p className="text-sm text-ink-tertiary">{bi('Aucun lieu.', 'No places.')}</p>
        : (
          <ul className="divide-y divide-divider border border-divider rounded-xl bg-white">
            {shown.map(p => (
              <li key={p.id}>
                <button type="button" onClick={() => setOpen(open === p.id ? null : p.id)} className="w-full text-left px-3 py-2.5 flex items-start gap-3">
                  <span className={`flex-shrink-0 text-[11px] font-bold px-2 py-0.5 rounded-full ${STATUS_PILL[p.status].cls}`}>{bi(STATUS_PILL[p.status].fr, STATUS_PILL[p.status].en)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink-primary truncate">{p.title_fr}</span>
                    <span className="block text-xs text-ink-tertiary truncate">
                      {placeCategoryLabel(p.category, locale)} · {[p.area, p.city].filter(Boolean).join(', ')}
                      {p.submitter && ` · ${bi('proposé par', 'suggested by')} ${p.submitter.name ?? p.submitter.phone ?? '?'}`}
                    </span>
                    {p.admin_note && p.status !== 'active' && <span className="block text-xs text-amber-800 mt-0.5 line-clamp-2">📝 {p.admin_note}</span>}
                  </span>
                </button>
                {open === p.id && <div className="px-3 pb-3"><PlaceForm place={p} onDone={() => { setOpen(null); load() }} /></div>}
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

function PlaceForm({ place, onDone }: { place?: AdminPlace; onDone: () => void }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const init = (k: keyof AdminPlace) => (place?.[k] ?? '') as string | number
  const [f, setF] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = { city: place?.city ?? 'Yaoundé', category: place?.category ?? '' }
    for (const x of FIELDS) o[x.k] = String(init(x.k))
    return o
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save(status?: Status) {
    setBusy(true); setErr(null)
    const body: Record<string, unknown> = { ...f }
    for (const k of ['lat', 'lng']) body[k] = f[k] === '' ? null : Number(f[k])
    if (status) body.status = status
    const r = await fetch(place ? `/api/admin/places/${place.id}` : '/api/admin/places', {
      method: place ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (r?.ok) onDone()
    else setErr(String(d?.error ?? 'Erreur / Error'))
  }

  return (
    <div className="rounded-xl border border-divider bg-surface p-3 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs font-semibold">{bi('Ville', 'City')}
          <select className={input} value={f.city} onChange={e => setF({ ...f, city: e.target.value })}>
            {Array.from(new Set([...CITIES, f.city])).map(c => <option key={c} value={c}>{c}</option>)}
          </select></label>
        <label className="block text-xs font-semibold">{bi('Catégorie', 'Category')}
          <select className={input} value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>
            <option value="">—</option>
            {PLACE_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {locale === 'en' ? c.en : c.fr}</option>)}
          </select></label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {FIELDS.map(x => (
          <label key={x.k} className={`block text-xs font-semibold ${x.area ? 'sm:col-span-2' : ''}`}>{bi(x.fr, x.en)}
            {x.area
              ? <textarea className={input} rows={3} value={f[x.k]} onChange={e => setF({ ...f, [x.k]: e.target.value })} />
              : <input className={input} value={f[x.k]} onChange={e => setF({ ...f, [x.k]: e.target.value })} inputMode={x.k === 'lat' || x.k === 'lng' ? 'decimal' : undefined} />}
          </label>
        ))}
      </div>
      {err && <p className="text-sm text-red-700">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => save()} className="px-4 py-2 rounded-full text-sm font-bold bg-ink-primary text-white disabled:opacity-60">
          {place ? bi('Enregistrer', 'Save') : bi('Créer (publié)', 'Create (published)')}
        </button>
        {!place && <button type="button" disabled={busy} onClick={() => save('hidden')} className="px-4 py-2 rounded-full text-sm font-bold border border-divider bg-white">{bi('Créer masqué', 'Create hidden')}</button>}
        {place && place.status !== 'active' && <button type="button" disabled={busy} onClick={() => save('active')} className="px-4 py-2 rounded-full text-sm font-bold bg-green-600 text-white">✓ {bi('Publier', 'Publish')}</button>}
        {place && place.status !== 'hidden' && <button type="button" disabled={busy} onClick={() => save('hidden')} className="px-4 py-2 rounded-full text-sm font-bold border border-divider bg-white">{bi('Masquer', 'Hide')}</button>}
        {place && <Link href={`/lieux/${place.id}`} target="_blank" className="px-4 py-2 rounded-full text-sm font-semibold text-brand-dark">{bi('Voir la page', 'View page')} ↗</Link>}
      </div>
    </div>
  )
}
