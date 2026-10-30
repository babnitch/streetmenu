'use client'

export const dynamic = 'force-dynamic'

// Admin → 🗂️ Données de référence (admin + super admin): cities, cuisines,
// event categories, À visiter categories. Edit labels FR/EN, icon,
// keywords (cuisines), city centre; show / hide; order; add a value.
// Never deleted — a value in use is hidden. "Utilisé par N" per value.
// Changes show on the site within a minute.

import { useCallback, useEffect, useState } from 'react'
import { useBi, pickBi, useLanguage } from '@/lib/languageContext'

type Kind = 'city' | 'cuisine' | 'event_category' | 'place_category'
interface Row {
  id: string; kind: Kind; code: string; label_fr: string; label_en: string; icon: string | null; keywords: string[]
  country: string | null; lat: number | null; lng: number | null; zoom: number | null; visible: boolean; sort_order: number
  usage: { total: number; detail: Record<string, number> }
}
const TABS: Array<[Kind, string, string]> = [
  ['city', 'Villes', 'Cities'], ['cuisine', 'Cuisines', 'Cuisines'],
  ['event_category', 'Catégories d\'événements', 'Event categories'], ['place_category', 'Catégories À visiter', 'To-visit categories'],
]
const DETAIL: Record<string, [string, string]> = {
  restaurants: ['restaurants', 'restaurants'], events: ['événements', 'events'], places: ['lieux', 'places'], profiles: ['profils', 'profiles'],
}
const input = 'w-full border border-divider rounded-lg px-2 py-1.5 text-sm bg-white'

export default function AdminReferencePage() {
  const bi = useBi()
  const [kind, setKind] = useState<Kind>('city')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    fetch('/api/admin/ref', { cache: 'no-store' }).then(async r => {
      const d = await r.json().catch(() => ({}))
      if (r.ok) setRows(d.values); else setError(d.error ?? 'Erreur')
    }).catch(() => setError('Erreur réseau / Network error'))
  }, [])
  useEffect(load, [load])
  const list = (rows ?? []).filter(r => r.kind === kind).sort((a, b) => a.sort_order - b.sort_order)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-ink-primary">🗂️ {bi('Données de référence', 'Reference data')}</h2>
        <p className="text-xs text-ink-tertiary">{bi('Une valeur utilisée ne se supprime pas : masquez-la. Masquée = plus proposée dans les listes ; les éléments qui l\'ont la gardent. Visible sur le site d\'ici une minute.', 'A value in use is never deleted: hide it. Hidden = no longer offered in lists; items that have it keep it. Live on the site within a minute.')}</p>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map(([k, fr, en]) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
            className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${kind === k ? 'bg-ink-primary text-white border-ink-primary' : 'bg-white border-divider text-ink-secondary'}`}>{bi(fr, en)}</button>
        ))}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {rows === null ? <p className="text-sm text-ink-tertiary">…</p> : (
        <>
          <ul className="space-y-2">
            {list.map((r, i) => <ValueRow key={r.id} row={r} first={i === 0} last={i === list.length - 1} onChanged={load} />)}
          </ul>
          <AddValue kind={kind} onAdded={load} />
        </>
      )}
    </div>
  )
}

function ValueRow({ row, first, last, onChanged }: { row: Row; first: boolean; last: boolean; onChanged: () => void }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [f, setF] = useState({
    label_fr: row.label_fr, label_en: row.label_en, icon: row.icon ?? '', keywords: row.keywords.join(', '),
    country: row.country ?? '', lat: row.lat == null ? '' : String(row.lat), lng: row.lng == null ? '' : String(row.lng),
  })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const dirty = f.label_fr !== row.label_fr || f.label_en !== row.label_en || f.icon !== (row.icon ?? '') || f.keywords !== row.keywords.join(', ')
    || f.country !== (row.country ?? '') || f.lat !== (row.lat == null ? '' : String(row.lat)) || f.lng !== (row.lng == null ? '' : String(row.lng))

  async function patch(body: Record<string, unknown>) {
    setBusy(true); setMsg('')
    const r = await fetch(`/api/admin/ref/${row.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (!r?.ok) { setMsg(pickBi(d.error ?? 'Erreur / Error', locale)); return }
    onChanged()
  }
  function save() {
    const body: Record<string, unknown> = { label_fr: f.label_fr, label_en: f.label_en }
    if (row.kind !== 'city') body.icon = f.icon
    if (row.kind === 'cuisine') body.keywords = f.keywords
    if (row.kind === 'city') Object.assign(body, { country: f.country, lat: f.lat, lng: f.lng })
    void patch(body)
  }
  const usage = Object.entries(row.usage.detail).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${bi(...(DETAIL[k] ?? [k, k]) as [string, string])}`).join(' · ')

  return (
    <li className={`rounded-xl border p-3 ${row.visible ? 'bg-white border-divider' : 'bg-surface-muted border-dashed border-divider'}`}>
      <div className="flex items-start gap-2">
        <div className="flex flex-col">
          <button type="button" disabled={busy || first} onClick={() => patch({ move: 'up' })} aria-label={bi('Monter', 'Move up')} className="px-1 text-ink-secondary disabled:opacity-30">▲</button>
          <button type="button" disabled={busy || last} onClick={() => patch({ move: 'down' })} aria-label={bi('Descendre', 'Move down')} className="px-1 text-ink-secondary disabled:opacity-30">▼</button>
        </div>
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {row.kind !== 'city' && <label className="text-[11px] text-ink-tertiary">{bi('Icône', 'Icon')}<input className={input} value={f.icon} onChange={e => setF({ ...f, icon: e.target.value })} maxLength={8} /></label>}
          <label className="text-[11px] text-ink-tertiary">FR<input className={input} value={f.label_fr} onChange={e => setF({ ...f, label_fr: e.target.value })} maxLength={60} /></label>
          <label className="text-[11px] text-ink-tertiary">EN<input className={input} value={f.label_en} onChange={e => setF({ ...f, label_en: e.target.value })} maxLength={60} /></label>
          {row.kind === 'city' && <>
            <label className="text-[11px] text-ink-tertiary">{bi('Pays', 'Country')}<input className={input} value={f.country} onChange={e => setF({ ...f, country: e.target.value })} maxLength={2} /></label>
            <label className="text-[11px] text-ink-tertiary">{bi('Centre (lat, lng)', 'Centre (lat, lng)')}
              <span className="flex gap-1"><input className={input} value={f.lat} onChange={e => setF({ ...f, lat: e.target.value })} inputMode="decimal" /><input className={input} value={f.lng} onChange={e => setF({ ...f, lng: e.target.value })} inputMode="decimal" /></span>
            </label>
          </>}
          {row.kind === 'cuisine' && <label className="text-[11px] text-ink-tertiary col-span-2">{bi('Mots-clés (séparés par des virgules)', 'Keywords (comma-separated)')}<input className={input} value={f.keywords} onChange={e => setF({ ...f, keywords: e.target.value })} /></label>}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <label className="flex items-center gap-1.5 text-xs font-semibold">
            <input type="checkbox" role="switch" checked={row.visible} disabled={busy} onChange={e => patch({ visible: e.target.checked })} className="w-4 h-4 accent-brand" />
            {row.visible ? bi('Visible', 'Visible') : bi('Masquée', 'Hidden')}
          </label>
          {dirty && <button type="button" disabled={busy} onClick={save} className="text-xs font-bold px-3 py-1 rounded-full bg-ink-primary text-white disabled:opacity-50">{bi('Enregistrer', 'Save')}</button>}
        </div>
      </div>
      <p className="mt-1.5 text-[11px] text-ink-tertiary">
        <span className="font-mono">{row.code}</span> · {bi('utilisé par', 'used by')} <strong>{row.usage.total}</strong>{usage ? ` (${usage})` : ''}
      </p>
      {msg && <p className="text-xs text-danger mt-1">{msg}</p>}
    </li>
  )
}

function AddValue({ kind, onAdded }: { kind: Kind; onAdded: () => void }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ label_fr: '', label_en: '', icon: '', keywords: '', country: '', lat: '', lng: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  async function add() {
    setBusy(true); setMsg('')
    const body: Record<string, unknown> = { kind, label_fr: f.label_fr, label_en: f.label_en }
    if (kind !== 'city') body.icon = f.icon
    if (kind === 'cuisine') body.keywords = f.keywords
    if (kind === 'city') Object.assign(body, { country: f.country, lat: f.lat, lng: f.lng, zoom: 13 })
    const r = await fetch('/api/admin/ref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (!r?.ok) { setMsg(pickBi(d.error ?? 'Erreur / Error', locale)); return }
    setOpen(false); setF({ label_fr: '', label_en: '', icon: '', keywords: '', country: '', lat: '', lng: '' }); onAdded()
  }
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="text-sm font-bold px-4 py-2 rounded-full border border-divider bg-white">+ {bi('Ajouter une valeur', 'Add a value')}</button>
  return (
    <div className="rounded-xl border border-brand/40 bg-white p-3 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {kind !== 'city' && <label className="text-[11px] text-ink-tertiary">{bi('Icône', 'Icon')}<input className={input} value={f.icon} onChange={e => setF({ ...f, icon: e.target.value })} maxLength={8} /></label>}
        <label className="text-[11px] text-ink-tertiary">FR *<input className={input} value={f.label_fr} onChange={e => setF({ ...f, label_fr: e.target.value })} maxLength={60} /></label>
        <label className="text-[11px] text-ink-tertiary">EN *<input className={input} value={f.label_en} onChange={e => setF({ ...f, label_en: e.target.value })} maxLength={60} /></label>
        {kind === 'city' && <>
          <label className="text-[11px] text-ink-tertiary">{bi('Pays (CM)', 'Country (CM)')}<input className={input} value={f.country} onChange={e => setF({ ...f, country: e.target.value })} maxLength={2} /></label>
          <label className="text-[11px] text-ink-tertiary">{bi('Centre (lat, lng) *', 'Centre (lat, lng) *')}
            <span className="flex gap-1"><input className={input} value={f.lat} onChange={e => setF({ ...f, lat: e.target.value })} inputMode="decimal" /><input className={input} value={f.lng} onChange={e => setF({ ...f, lng: e.target.value })} inputMode="decimal" /></span>
          </label>
        </>}
        {kind === 'cuisine' && <label className="text-[11px] text-ink-tertiary col-span-2">{bi('Mots-clés', 'Keywords')}<input className={input} value={f.keywords} onChange={e => setF({ ...f, keywords: e.target.value })} /></label>}
      </div>
      {msg && <p className="text-xs text-danger">{msg}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={add} className="text-sm font-bold px-4 py-1.5 rounded-full bg-ink-primary text-white disabled:opacity-50">{bi('Ajouter', 'Add')}</button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm px-3 py-1.5">{bi('Annuler', 'Cancel')}</button>
      </div>
    </div>
  )
}
