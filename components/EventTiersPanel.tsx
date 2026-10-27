'use client'

import { useState, useEffect, useCallback } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { formatEventDay } from '@/lib/eventDate'
import type { DayAvailability } from '@/lib/eventSeats'

interface Tier {
  id:           string
  name:         string
  name_en:      string | null
  price:        number
  max_quantity: number
  sold_count:   number
  sort_order:   number
  is_active:    boolean
  description:  string | null
  sales_start:  string | null
  sales_end:    string | null
}

interface TierDraft {
  name:         string
  name_en:      string
  price:        string
  max_quantity: string
  description:  string
}

// Tier management panel mounted inside MyEventsPanel for a single event.
// Lists every tier (including inactive — sold-out historical rows stay
// visible), supports add + inline edit + soft-deactivate. Deactivate is
// the only "delete" path because sold reservations reference the tier_id.
//
// Capacity is per day: on a multi-day event a tier's max is "max par jour".
// onTiersLoaded hands the parent the active tiers' max after every load, so
// it can show the event's capacity (their sum) without its own request.
export default function EventTiersPanel({ eventId, multiDay = false, onTiersLoaded }: { eventId: string; multiDay?: boolean; onTiersLoaded?: (activeMaxPerDay: number[]) => void }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [tiers, setTiers] = useState<Tier[]>([])
  // Seats sold per day and per tier (capacity is per day). The tier's own
  // sold_count is an all-days total and is only a fallback here.
  const [days, setDays] = useState<DayAvailability[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<TierDraft>({ name: '', name_en: '', price: '', max_quantity: '', description: '' })
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, a] = await Promise.all([
        fetch(`/api/events/${eventId}/tiers`, { cache: 'no-store' }),
        fetch(`/api/events/${eventId}/availability`, { cache: 'no-store' }).catch(() => null),
      ])
      const d = await r.json()
      if (Array.isArray(d?.tiers)) {
        setTiers(d.tiers)
        onTiersLoaded?.((d.tiers as Tier[]).filter(t => t.is_active).map(t => Number(t.max_quantity ?? 0)))
      }
      const av = a ? await a.json().catch(() => null) : null
      setDays(Array.isArray(av?.days) ? av.days : null)
    } finally { setLoading(false) }
  }, [eventId, onTiersLoaded])

  useEffect(() => { load() }, [load])

  // "3/10 vendus" for a single-day event; one "22 oct. 3/10" per upcoming
  // day for a multi-day one (the cap applies to each day).
  function soldLines(t: Tier): string[] {
    const fmt = (sold: number) => t.max_quantity === 0
      ? `${sold} ${bi('vendus', 'sold')}`
      : `${sold}/${t.max_quantity} ${bi('vendus', 'sold')}`
    const upcoming = (days ?? []).filter(d => !d.past)
    const perDay = upcoming
      .map(d => ({ date: d.date, entry: d.tiers.find(x => x.tier_id === t.id) }))
      .filter(x => x.entry)
    if (perDay.length === 0) return [fmt(t.sold_count)]
    if (perDay.length === 1 && upcoming.length === 1) return [fmt(perDay[0].entry!.sold)]
    return perDay.map(x => `${formatEventDay(x.date, locale, 'compact')} ${fmt(x.entry!.sold)}`)
  }

  function beginEdit(t: Tier) {
    setEditingId(t.id)
    setDraft({
      name:         t.name,
      name_en:      t.name_en ?? '',
      price:        String(t.price),
      max_quantity: String(t.max_quantity),
      description:  t.description ?? '',
    })
  }

  async function saveEdit() {
    if (!editingId) return
    setBusy(editingId)
    try {
      const res = await fetch(`/api/events/${eventId}/tiers/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:         draft.name.trim(),
          name_en:      draft.name_en.trim() || null,
          price:        Math.max(0, Number.parseInt(draft.price, 10) || 0),
          max_quantity: Math.max(0, Number.parseInt(draft.max_quantity, 10) || 0),
          description:  draft.description.trim() || null,
        }),
      })
      if (res.ok) {
        setEditingId(null)
        await load()
      }
    } finally { setBusy(null) }
  }

  async function deactivate(t: Tier) {
    const confirmMsg = t.sold_count > 0
      ? bi(
          `${t.name} a ${t.sold_count} ventes — désactiver?`,
          `${t.name} has ${t.sold_count} sales — deactivate?`,
        )
      : bi(`Désactiver ${t.name}?`, `Deactivate ${t.name}?`)
    if (!confirm(confirmMsg)) return
    setBusy(t.id)
    try {
      const res = await fetch(`/api/events/${eventId}/tiers/${t.id}`, { method: 'DELETE' })
      if (res.ok) await load()
    } finally { setBusy(null) }
  }

  async function reactivate(t: Tier) {
    setBusy(t.id)
    try {
      const res = await fetch(`/api/events/${eventId}/tiers/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: true }),
      })
      if (res.ok) await load()
    } finally { setBusy(null) }
  }

  async function createTier() {
    if (!draft.name.trim()) return
    setBusy('new')
    try {
      const res = await fetch(`/api/events/${eventId}/tiers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:         draft.name.trim(),
          name_en:      draft.name_en.trim() || null,
          price:        Math.max(0, Number.parseInt(draft.price, 10) || 0),
          max_quantity: Math.max(0, Number.parseInt(draft.max_quantity, 10) || 0),
          description:  draft.description.trim() || null,
          sort_order:   tiers.length,
        }),
      })
      if (res.ok) {
        setAdding(false)
        setDraft({ name: '', name_en: '', price: '', max_quantity: '', description: '' })
        await load()
      }
    } finally { setBusy(null) }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
          🎫 {bi('Tarifs', 'Tiers')}
        </p>
        {!adding && (
          <button
            onClick={() => { setAdding(true); setDraft({ name: '', name_en: '', price: '', max_quantity: '', description: '' }) }}
            className="text-xs font-semibold text-brand hover:text-brand-dark"
          >
            + {bi('Ajouter', 'Add')}
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-ink-tertiary">{bi('Chargement…', 'Loading…')}</p>
      ) : tiers.length === 0 && !adding ? (
        <p className="text-xs text-ink-tertiary">
          {bi('Aucun tarif. Utilisez le prix par défaut de l\'événement.', 'No tiers. The event\'s default price is used.')}
        </p>
      ) : (
        <div className="space-y-2">
          {tiers.map(t => {
            const isEditing = editingId === t.id
            const inactive = !t.is_active
            if (isEditing) {
              return (
                <div key={t.id} className="bg-surface-muted rounded-xl p-2.5 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input className="bg-white border border-divider rounded-lg px-2 py-1 text-sm"
                      value={draft.name} onChange={e => setDraft(p => ({ ...p, name: e.target.value }))}
                      placeholder={bi('Nom (FR)', 'Name (FR)')} />
                    <input className="bg-white border border-divider rounded-lg px-2 py-1 text-sm"
                      value={draft.name_en} onChange={e => setDraft(p => ({ ...p, name_en: e.target.value }))}
                      placeholder={bi('Nom (EN)', 'Name (EN)')} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input type="number" min="0" className="bg-white border border-divider rounded-lg px-2 py-1 text-sm"
                      value={draft.price} onChange={e => setDraft(p => ({ ...p, price: e.target.value }))}
                      placeholder={bi('Prix FCFA', 'Price FCFA')} />
                    <input type="number" min="0" className="bg-white border border-divider rounded-lg px-2 py-1 text-sm"
                      value={draft.max_quantity} onChange={e => setDraft(p => ({ ...p, max_quantity: e.target.value }))}
                      placeholder={multiDay ? bi('Max par jour', 'Max per day') : bi('Quantité max', 'Max qty')} />
                  </div>
                  <input className="w-full bg-white border border-divider rounded-lg px-2 py-1 text-sm"
                    value={draft.description} onChange={e => setDraft(p => ({ ...p, description: e.target.value }))}
                    placeholder={bi('Description', 'Description')} />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} disabled={busy === t.id}
                      className="flex-1 text-xs font-semibold bg-brand text-white py-1.5 rounded-lg disabled:opacity-50">
                      💾 {bi('Enregistrer', 'Save')}
                    </button>
                    <button onClick={() => setEditingId(null)}
                      className="flex-1 text-xs font-semibold bg-white border border-divider py-1.5 rounded-lg">
                      {bi('Annuler', 'Cancel')}
                    </button>
                  </div>
                </div>
              )
            }
            return (
              <div key={t.id} className={`rounded-xl p-2.5 ${inactive ? 'bg-surface-muted/50 opacity-70' : 'bg-surface-muted'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink-primary">
                      🎫 {t.name}{t.name_en ? ` / ${t.name_en}` : ''}
                      {inactive && <span className="text-[10px] ml-2 text-ink-tertiary">({bi('inactif', 'inactive')})</span>}
                    </p>
                    {t.description && <p className="text-xs text-ink-tertiary mt-0.5">{t.description}</p>}
                    <p className="text-xs text-ink-tertiary mt-0.5">
                      {t.price === 0 ? bi('Gratuit', 'Free') : `${t.price.toLocaleString()} FCFA`}
                      {soldLines(t).length === 1 && <>{' · '}{soldLines(t)[0]}</>}
                    </p>
                    {soldLines(t).length > 1 && (
                      <p className="text-[11px] text-ink-tertiary mt-0.5">{soldLines(t).join(' · ')}</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 items-end flex-shrink-0">
                    <button onClick={() => beginEdit(t)}
                      className="text-xs font-semibold text-ink-secondary hover:text-ink-primary">
                      ✏️
                    </button>
                    {inactive ? (
                      <button onClick={() => reactivate(t)} disabled={busy === t.id}
                        className="text-xs font-semibold text-brand hover:text-brand-dark disabled:opacity-50">
                        🔓
                      </button>
                    ) : (
                      <button onClick={() => deactivate(t)} disabled={busy === t.id}
                        className="text-xs font-semibold text-rose-600 hover:text-rose-700 disabled:opacity-50">
                        🗑️
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}

          {adding && (
            <div className="bg-brand-light/30 border border-brand-light rounded-xl p-2.5 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input className="bg-white border border-divider rounded-lg px-2 py-1 text-sm"
                  value={draft.name} onChange={e => setDraft(p => ({ ...p, name: e.target.value }))}
                  placeholder={bi('Nom (FR)', 'Name (FR)')} />
                <input className="bg-white border border-divider rounded-lg px-2 py-1 text-sm"
                  value={draft.name_en} onChange={e => setDraft(p => ({ ...p, name_en: e.target.value }))}
                  placeholder={bi('Nom (EN)', 'Name (EN)')} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input type="number" min="0" className="bg-white border border-divider rounded-lg px-2 py-1 text-sm"
                  value={draft.price} onChange={e => setDraft(p => ({ ...p, price: e.target.value }))}
                  placeholder={bi('Prix FCFA', 'Price FCFA')} />
                <input type="number" min="0" className="bg-white border border-divider rounded-lg px-2 py-1 text-sm"
                  value={draft.max_quantity} onChange={e => setDraft(p => ({ ...p, max_quantity: e.target.value }))}
                  placeholder={multiDay ? bi('Max par jour', 'Max per day') : bi('Quantité max', 'Max qty')} />
              </div>
              <input className="w-full bg-white border border-divider rounded-lg px-2 py-1 text-sm"
                value={draft.description} onChange={e => setDraft(p => ({ ...p, description: e.target.value }))}
                placeholder={bi('Description', 'Description')} />
              <div className="flex gap-2">
                <button onClick={createTier} disabled={busy === 'new' || !draft.name.trim()}
                  className="flex-1 text-xs font-semibold bg-brand text-white py-1.5 rounded-lg disabled:opacity-50">
                  ➕ {bi('Créer', 'Create')}
                </button>
                <button onClick={() => setAdding(false)}
                  className="flex-1 text-xs font-semibold bg-white border border-divider py-1.5 rounded-lg">
                  {bi('Annuler', 'Cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
