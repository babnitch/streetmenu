'use client'

// Admin → Commandes → Problèmes (protected payments, P1d). Problems the
// customers reported; the money stays held until an admin decides:
//   Verser au restaurant · Rembourser tout · Rembourser une partie (the rest
//   goes to the restaurant once the refund completes). Audited.

import { useCallback, useEffect, useState } from 'react'
import { useBi, pickBi, useLanguage } from '@/lib/languageContext'
import { formatFCFA } from '@/lib/money'

interface Problem {
  id: string; order_id: string; code4: string; via: string; reason: string; status: string; created_at: string
  resolved_at: string | null; note: string | null; restaurant: string | null; customer_name: string | null
  customer_phone: string | null; total_price: number; held: number; funds_status: string | null; order_status: string
}

const STATUS: Record<string, [string, string]> = {
  open: ['⚠️ À décider', '⚠️ To decide'],
  released: ['✅ Versé au restaurant', '✅ Paid to the restaurant'],
  refunded: ['↩️ Remboursé', '↩️ Refunded'],
  partly_refunded: ['↩️ Remboursé en partie', '↩️ Partly refunded'],
}

export default function AdminProblems() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [list, setList] = useState<Problem[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null)
  const [partial, setPartial] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    fetch('/api/admin/problems', { cache: 'no-store' }).then(r => r.ok ? r.json() : { problems: [] })
      .then(d => setList(d.problems ?? [])).catch(() => setList([]))
  }, [])
  useEffect(() => { load() }, [load])

  async function decide(p: Problem, decision: 'release' | 'refund' | 'partial') {
    const amount = Number(partial[p.id] ?? 0)
    const ask = decision === 'release'
      ? bi(`Verser ${formatFCFA(p.held)} au restaurant ?`, `Pay ${formatFCFA(p.held)} to the restaurant?`)
      : decision === 'refund'
        ? bi(`Rembourser ${formatFCFA(p.held)} au client ?`, `Refund ${formatFCFA(p.held)} to the customer?`)
        : bi(`Rembourser ${formatFCFA(amount)} et verser ${formatFCFA(p.held - amount)} au restaurant ?`, `Refund ${formatFCFA(amount)} and pay ${formatFCFA(p.held - amount)} to the restaurant?`)
    if (!window.confirm(ask)) return
    setBusy(p.id); setMsg(null)
    const r = await fetch(`/api/admin/problems/${p.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, amount: decision === 'partial' ? amount : undefined, note: notes[p.id] ?? '' }),
    }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(null)
    setMsg({ id: p.id, ok: !!r?.ok, text: r?.ok ? bi('✅ Décision enregistrée', '✅ Decision saved') : pickBi(String(d?.error ?? 'Erreur / Error'), locale) })
    if (r?.ok) load()
  }

  if (!list) return <p className="text-ink-tertiary">…</p>
  if (list.length === 0) return <p className="bg-white rounded-2xl shadow-sm p-6 text-sm text-ink-tertiary">{bi('Aucun problème signalé.', 'No problem reported.')}</p>
  return (
    <ul className="space-y-3">
      {list.map(p => (
        <li key={p.id} className="bg-white rounded-2xl shadow-sm p-4">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <p className="font-semibold text-ink-primary text-sm">#{p.code4} · {p.restaurant ?? '—'}</p>
              <p className="text-xs text-ink-tertiary">{p.customer_name ?? '—'} · {p.customer_phone ?? ''} · {new Date(p.created_at).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR')} · {p.via === 'whatsapp' ? 'WhatsApp' : 'Web'}</p>
            </div>
            <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-surface-muted text-ink-secondary">{bi(...(STATUS[p.status] ?? [p.status, p.status]))}</span>
          </div>
          <p className="mt-2 text-sm text-ink-primary whitespace-pre-wrap">📝 {p.reason}</p>
          {p.note && <p className="mt-1 text-xs text-ink-tertiary">🗒 {p.note}</p>}
          {p.status === 'open' && (
            <div className="mt-3 border-t border-divider pt-3 space-y-2">
              <p className="text-sm">{bi('Retenu', 'Held')} : <b>{formatFCFA(p.held)}</b> <span className="text-ink-tertiary">/ {formatFCFA(p.total_price)}</span></p>
              <input value={notes[p.id] ?? ''} onChange={e => setNotes(n => ({ ...n, [p.id]: e.target.value }))} maxLength={500}
                placeholder={bi('Note (facultatif)', 'Note (optional)')} className="w-full border border-divider rounded-lg px-3 py-2 text-base outline-none focus:border-brand" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button type="button" disabled={busy === p.id || p.held <= 0} onClick={() => decide(p, 'release')}
                  className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-semibold">{bi('Verser au restaurant', 'Pay the restaurant')}</button>
                <button type="button" disabled={busy === p.id || p.held <= 0} onClick={() => decide(p, 'refund')}
                  className="bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-semibold">{bi('Rembourser tout', 'Refund all')}</button>
                <div className="flex gap-1">
                  <input value={partial[p.id] ?? ''} onChange={e => setPartial(x => ({ ...x, [p.id]: e.target.value.replace(/\D/g, '') }))} inputMode="numeric"
                    placeholder="FCFA" aria-label={bi('Montant à rembourser', 'Amount to refund')} className="w-24 border border-divider rounded-lg px-2 py-2 text-base outline-none focus:border-brand" />
                  <button type="button" disabled={busy === p.id || !(Number(partial[p.id]) > 0 && Number(partial[p.id]) < p.held)} onClick={() => decide(p, 'partial')}
                    className="flex-1 border border-rose-300 text-rose-700 disabled:opacity-50 py-2 rounded-lg text-xs font-semibold">{bi('Rembourser une partie', 'Refund part')}</button>
                </div>
              </div>
            </div>
          )}
          {msg?.id === p.id && <p className={`mt-2 text-sm ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}
        </li>
      ))}
    </ul>
  )
}
