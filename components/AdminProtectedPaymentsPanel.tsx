'use client'

// Admin → ⚙️ Plateforme → "Paiements protégés" (super admin). The master
// switch and the settings of protected payments (lib/protectedPayments.ts).
// A restaurant is protected only when this switch is ON and its module
// "Paiement protégé" is ON.

import { useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'

interface Settings { master: boolean; acceptTimeoutMin: number; autoReleaseHours: number; codeMaxTries: number; commissionOrderPct: number }
type NumKey = Exclude<keyof Settings, 'master'>

const FIELDS: Array<{ k: NumKey; fr: string; en: string; unit: string; min: number; max: number; step?: number }> = [
  { k: 'acceptTimeoutMin',   fr: 'Délai d\'acceptation', en: 'Time to accept', unit: 'min', min: 5, max: 120 },
  { k: 'autoReleaseHours',   fr: 'Versement automatique après remise sans code', en: 'Automatic payment after hand-over without code', unit: 'h', min: 1, max: 168 },
  { k: 'codeMaxTries',       fr: 'Essais de code avant blocage', en: 'Code tries before lock', unit: '×', min: 3, max: 10 },
  { k: 'commissionOrderPct', fr: 'Commission sur les commandes', en: 'Commission on orders', unit: '%', min: 0, max: 30, step: 0.5 },
]

export default function AdminProtectedPaymentsPanel() {
  const bi = useBi()
  const [s, setS] = useState<Settings | null>(null)
  const [sandbox, setSandbox] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetch('/api/admin/protected-payments', { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setS(d.settings); setSandbox(d.sandbox === true) } }).catch(() => null)
  }, [])

  async function save(patch: Partial<Settings>) {
    setBusy(true); setMsg(null)
    const r = await fetch('/api/admin/protected-payments', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (r?.ok) { setS(d.settings); setMsg({ ok: true, text: bi('✅ Enregistré', '✅ Saved') }) }
    else setMsg({ ok: false, text: String(d?.error ?? 'Erreur / Error') })
  }

  if (!s) return null
  return (
    <section className="bg-white rounded-2xl shadow-sm p-5">
      <h2 className="font-bold text-ink-primary">🛡️ {bi('Paiements protégés', 'Protected payments')}</h2>
      <p className="text-xs text-ink-tertiary mt-1">
        {bi('L\'argent des commandes payées est retenu jusqu\'à la remise (code du client), puis versé au restaurant. Actif pour un restaurant seulement si cet interrupteur ET son module « Paiement protégé » sont activés.',
          'Money for paid orders is held until hand-over (the customer\'s code), then paid to the restaurant. Active for a restaurant only when this switch AND its "Protected payment" module are on.')}
      </p>
      {sandbox && (
        <p className="mt-2 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {bi('PawaPay en SANDBOX : tout l\'argent retenu et versé est marqué « test » et ne compte dans aucun solde réel.', 'PawaPay in SANDBOX: all money held and paid out is marked "test" and never counts in a real balance.')}
        </p>
      )}
      <label className="mt-4 flex items-center justify-between gap-3 border border-divider rounded-xl px-4 py-3">
        <span className="text-sm font-semibold text-ink-primary">{bi('Activé sur la plateforme', 'On for the platform')}</span>
        <input type="checkbox" checked={s.master} disabled={busy} onChange={e => save({ master: e.target.checked })} className="w-5 h-5 accent-brand" />
      </label>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIELDS.map(f => (
          <label key={f.k} className="block">
            <span className="text-xs font-semibold text-ink-secondary">{bi(f.fr, f.en)} ({f.unit})</span>
            <input type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step ?? 1} value={s[f.k]}
              onChange={e => setS(x => x && { ...x, [f.k]: Number(e.target.value) })}
              className="mt-1 w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand" />
          </label>
        ))}
      </div>
      <button type="button" disabled={busy}
        onClick={() => save({ acceptTimeoutMin: s.acceptTimeoutMin, autoReleaseHours: s.autoReleaseHours, codeMaxTries: s.codeMaxTries, commissionOrderPct: s.commissionOrderPct })}
        className="mt-4 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-semibold">
        {busy ? '…' : bi('Enregistrer', 'Save')}
      </button>
      {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}
    </section>
  )
}
