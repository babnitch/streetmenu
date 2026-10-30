'use client'

// Restaurant links (I2): Instagram, Facebook, TikTok, website. Owner /
// manager in Paramètres (PATCH /api/restaurants/[id]); the admin card adds
// the admin-only phone to verify and a note (PUT …/admin/…/details).

import { useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { LINK_FIELDS, LINK_LABELS, type LinkField } from '@/lib/restaurantLinks'

type Values = Partial<Record<LinkField | 'phone_to_verify' | 'note', string>>

export default function RestaurantLinksForm({ restaurantId, admin = false, initial }: {
  restaurantId: string
  admin?: boolean
  initial?: Values
}) {
  const bi = useBi()
  const [v, setV] = useState<Values | null>(admin ? null : (initial ?? {}))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; field?: string } | null>(null)

  useEffect(() => {
    if (!admin) return
    fetch(`/api/admin/restaurants/${restaurantId}/details`, { cache: 'no-store' }).then(r => r.ok ? r.json() : {})
      .then(d => setV(Object.fromEntries(Object.entries(d).map(([k, x]) => [k, (x as string | null) ?? '']))))
      .catch(() => setV({}))
  }, [admin, restaurantId])

  async function save() {
    if (!v) return
    setBusy(true); setMsg(null)
    const r = admin
      ? await fetch(`/api/admin/restaurants/${restaurantId}/details`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }).catch(() => null)
      : await fetch(`/api/restaurants/${restaurantId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(LINK_FIELDS.map(f => [f, v[f] ?? '']))) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    setMsg(r?.ok ? { ok: true, text: bi('Enregistré', 'Saved') } : { ok: false, text: String(d?.error ?? 'Erreur / Error').split(' / ')[0], field: d?.field })
  }

  const input = (k: keyof Values, label: string, ph?: string) => (
    <label key={k} className="block">
      <span className="text-xs font-semibold text-ink-secondary">{label}</span>
      <input value={v?.[k] ?? ''} placeholder={ph} onChange={e => setV(x => ({ ...(x ?? {}), [k]: e.target.value }))}
        className={`mt-1 w-full border rounded-xl px-3 py-2 text-sm outline-none focus:border-brand ${msg?.field === k ? 'border-danger' : 'border-divider'}`} />
    </label>
  )

  if (!v) return <p className="text-xs text-ink-tertiary">…</p>
  return (
    <div className="space-y-2">
      {LINK_FIELDS.map(f => input(f, `${LINK_LABELS[f].icon} ${bi(LINK_LABELS[f].fr, LINK_LABELS[f].en)}`, 'https://…'))}
      {admin && (
        <div className="pt-2 mt-2 border-t border-divider space-y-2">
          <p className="text-[11px] text-ink-tertiary">🔒 {bi('Admin seulement — jamais affiché, jamais utilisé pour les commandes ni WhatsApp.', 'Admin only — never shown, never used for orders or WhatsApp.')}</p>
          {input('phone_to_verify', bi('Téléphone à vérifier', 'Phone to verify'), '+237…')}
          {input('note', bi('Note admin', 'Admin note'))}
        </div>
      )}
      <button type="button" onClick={save} disabled={busy}
        className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-semibold">
        {busy ? '…' : bi('Enregistrer', 'Save')}
      </button>
      {msg && <p className={`text-xs ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}
    </div>
  )
}
