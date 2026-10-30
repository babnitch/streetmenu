'use client'

// Admin → Commandes → À payer (protected payments, P2). Each pro's
// available balance; "Payer" sends all of it to their payout number (one
// payout per pro per day). New payout numbers asked by pros are confirmed
// here.

import { useCallback, useEffect, useState } from 'react'
import { useBi, pickBi, useLanguage } from '@/lib/languageContext'
import { formatFCFA } from '@/lib/money'

interface Row { restaurant_id: string; name: string; city: string; available: number; in_transit: number; phone: string | null; phone_pending: string | null; paid_today: boolean }

export default function AdminToPay() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [sandbox, setSandbox] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null)

  const load = useCallback(() => {
    fetch('/api/admin/payouts', { cache: 'no-store' }).then(r => r.ok ? r.json() : { rows: [] })
      .then(d => { setRows(d.rows ?? []); setSandbox(d.sandbox === true) }).catch(() => setRows([]))
  }, [])
  useEffect(() => { load() }, [load])

  async function post(id: string, url: string, body: unknown, ask: string) {
    if (!window.confirm(ask)) return
    setBusy(id); setMsg(null)
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(null)
    setMsg({ id, ok: !!r?.ok, text: r?.ok ? bi('✅ Fait', '✅ Done') : pickBi(String(d?.error ?? 'Erreur / Error'), locale) })
    load()
  }

  if (!rows) return <p className="text-ink-tertiary">…</p>
  return (
    <div className="space-y-3">
      {sandbox && <p className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{bi('PawaPay en SANDBOX : soldes et paiements de test uniquement.', 'PawaPay in SANDBOX: test balances and payouts only.')}</p>}
      {rows.length === 0 && <p className="bg-white rounded-2xl shadow-sm p-6 text-sm text-ink-tertiary">{bi('Rien à payer.', 'Nothing to pay.')}</p>}
      {rows.map(r => (
        <div key={r.restaurant_id} className="bg-white rounded-2xl shadow-sm p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-ink-primary truncate">{r.name}</p>
              <p className="text-xs text-ink-tertiary">{r.city} · 📱 {r.phone ?? '—'}</p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="font-bold text-emerald-700">{formatFCFA(r.available)}</p>
              {r.in_transit > 0 && <p className="text-xs text-ink-tertiary">{bi('en cours', 'sending')} {formatFCFA(r.in_transit)}</p>}
            </div>
          </div>
          {r.phone_pending && (
            <div className="mt-2 border border-amber-200 bg-amber-50 rounded-lg p-2 text-sm">
              <p>{bi('Nouveau numéro demandé', 'New number asked')} : <b className="font-mono">{r.phone_pending}</b></p>
              <div className="flex gap-2 mt-1">
                <button type="button" disabled={busy === r.restaurant_id} onClick={() => post(r.restaurant_id, '/api/admin/payouts/phone', { restaurant_id: r.restaurant_id, approve: true }, bi(`Confirmer ${r.phone_pending} ? Vérifiez d'abord avec le propriétaire.`, `Confirm ${r.phone_pending}? Check with the owner first.`))}
                  className="flex-1 bg-emerald-600 text-white py-1.5 rounded-lg text-xs font-semibold">{bi('Confirmer', 'Confirm')}</button>
                <button type="button" disabled={busy === r.restaurant_id} onClick={() => post(r.restaurant_id, '/api/admin/payouts/phone', { restaurant_id: r.restaurant_id, approve: false }, bi('Refuser ce numéro ?', 'Decline this number?'))}
                  className="flex-1 border border-divider py-1.5 rounded-lg text-xs font-semibold text-ink-secondary">{bi('Refuser', 'Decline')}</button>
              </div>
            </div>
          )}
          {r.available > 0 && (
            <button type="button" disabled={busy === r.restaurant_id || r.paid_today || !r.phone}
              onClick={() => post(r.restaurant_id, '/api/admin/payouts', { restaurant_id: r.restaurant_id }, bi(`Envoyer ${formatFCFA(r.available)} à ${r.name} (${r.phone}) ?`, `Send ${formatFCFA(r.available)} to ${r.name} (${r.phone})?`))}
              className="mt-3 w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white py-2.5 rounded-xl text-sm font-bold">
              {r.paid_today ? bi('Déjà payé aujourd\'hui', 'Already paid today') : `💸 ${bi('Payer', 'Pay')} ${formatFCFA(r.available)}`}
            </button>
          )}
          {msg?.id === r.restaurant_id && <p className={`mt-2 text-sm ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}
        </div>
      ))}
    </div>
  )
}
