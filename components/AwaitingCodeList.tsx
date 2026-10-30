'use client'

// Valider → "En attente du code" (protected payments). Orders whose money is
// held until the customer's hand-over code is typed. The restaurant picks
// the order, then types the code: right → handed over and the money goes to
// its balance. Hidden when no order is waiting.

import { useCallback, useEffect, useState } from 'react'
import { useBi, pickBi, useLanguage } from '@/lib/languageContext'
import { formatFCFA } from '@/lib/money'

interface Awaiting { id: string; code4: string; customer_name: string | null; total_price: number; status: string; fulfilment: string | null; locked: boolean }

export default function AwaitingCodeList({ restaurantId }: { restaurantId: string }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [orders, setOrders] = useState<Awaiting[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(() => {
    fetch(`/api/restaurants/${restaurantId}/awaiting-code`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { orders: [] }).then(d => setOrders(d.orders ?? [])).catch(() => null)
  }, [restaurantId])
  useEffect(() => { load() }, [load])

  async function submit(id: string) {
    setBusy(true); setMsg(null)
    const r = await fetch(`/api/orders/${id}/release-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (r?.ok) {
      setMsg({ ok: true, text: bi(`✅ Code correct — ${formatFCFA(d.amount)} ajoutés à votre solde.`, `✅ Right code — ${formatFCFA(d.amount)} added to your balance.`) })
      setOpen(null); setCode(''); load()
    } else {
      setMsg({ ok: false, text: pickBi(String(d?.error ?? 'Erreur / Error'), locale) })
      if (r?.status === 423) load()
    }
  }

  if (orders.length === 0 && !msg) return null
  return (
    <div className="mt-4 border border-amber-200 bg-amber-50 rounded-xl p-3">
      <p className="text-sm font-bold text-amber-900">🛡️ {bi('En attente du code', 'Waiting for the code')} ({orders.length})</p>
      <p className="text-xs text-amber-800 mt-0.5">{bi('Payé – retenu par Tchop & Ndjoka. Choisissez la commande, puis tapez le code du client à la remise.', 'Paid – held by Tchop & Ndjoka. Pick the order, then type the customer\'s code at hand-over.')}</p>
      {msg && <p className={`mt-2 text-sm font-semibold ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}
      <ul className="mt-2 space-y-2">
        {orders.map(o => (
          <li key={o.id} className="bg-white rounded-lg border border-divider p-2.5">
            <button type="button" disabled={o.locked} onClick={() => { setOpen(open === o.id ? null : o.id); setCode(''); setMsg(null) }}
              className="w-full flex items-center justify-between gap-2 text-left disabled:opacity-60">
              <span className="text-sm font-semibold text-ink-primary truncate">#{o.code4} · {o.customer_name ?? '—'}</span>
              <span className="text-sm font-bold text-brand flex-shrink-0">{o.locked ? `🔒 ${bi('Bloquée', 'Locked')}` : formatFCFA(o.total_price)}</span>
            </button>
            {open === o.id && (
              <form className="flex gap-2 mt-2" onSubmit={e => { e.preventDefault(); void submit(o.id) }}>
                <input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" autoComplete="one-time-code"
                  placeholder="1234" aria-label={bi('Code du client', 'Customer code')}
                  className="flex-1 min-w-0 border border-divider rounded-xl px-3 py-2.5 text-base font-mono tracking-widest outline-none focus:border-brand" />
                <button type="submit" disabled={busy || code.length !== 4}
                  className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-semibold">
                  {busy ? '…' : bi('Valider', 'Validate')}
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
