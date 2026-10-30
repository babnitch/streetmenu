'use client'

// Pro → Aperçu → "Mon argent / My money" (protected payments, P2). Held
// (waiting for hand-over), available (paid out by Tchop & Ndjoka), in
// transit, paid out; the payout number. Owner + manager; only the owner
// asks for a new payout number (an admin confirms it).

import { useCallback, useEffect, useState } from 'react'
import { useBi, pickBi, useLanguage } from '@/lib/languageContext'
import { formatFCFA } from '@/lib/money'

interface Money {
  balances: { held: number; available: number; in_transit: number; paid_out: number }
  sandbox: boolean; payout_phone: string | null; payout_phone_pending: string | null
  payouts: Array<{ id: string; amount: number; day: string; status: string }>
}

export default function MyMoneyPanel({ restaurantId, isOwner }: { restaurantId: string; isOwner: boolean }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [m, setM] = useState<Money | null>(null)
  const [edit, setEdit] = useState(false)
  const [phone, setPhone] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(() => {
    fetch(`/api/restaurants/${restaurantId}/money`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(setM).catch(() => null)
  }, [restaurantId])
  useEffect(() => { load() }, [load])

  async function askPhone() {
    setMsg(null)
    const r = await fetch(`/api/restaurants/${restaurantId}/payout-phone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    if (r?.ok) { setEdit(false); setPhone(''); setMsg({ ok: true, text: bi('Demande envoyée : Tchop & Ndjoka confirme le nouveau numéro.', 'Request sent: Tchop & Ndjoka confirms the new number.') }); load() }
    else setMsg({ ok: false, text: pickBi(String(d?.error ?? 'Erreur / Error'), locale) })
  }

  if (!m) return null
  const b = m.balances
  const tiles: Array<[string, string, number, string]> = [
    ['🛡️', bi('Retenu (en attente de remise)', 'Held (waiting for hand-over)'), b.held, 'text-amber-700'],
    ['💰', bi('Disponible', 'Available'), b.available, 'text-emerald-700'],
    ['🚚', bi('En cours d\'envoi', 'Being sent'), b.in_transit, 'text-ink-primary'],
    ['✅', bi('Déjà versé', 'Paid out'), b.paid_out, 'text-ink-secondary'],
  ]
  return (
    <section className="bg-white rounded-2xl shadow-sm p-4 mb-4">
      <h3 className="font-bold text-ink-primary">💼 {bi('Mon argent', 'My money')}</h3>
      {m.sandbox && <p className="text-xs text-amber-700 mt-0.5">{bi('Mode test (sandbox) : montants de test.', 'Test mode (sandbox): test amounts.')}</p>}
      <div className="grid grid-cols-2 gap-2 mt-3">
        {tiles.map(([icon, label, v, cls]) => (
          <div key={label} className="border border-divider rounded-xl p-3">
            <p className="text-xs text-ink-tertiary">{icon} {label}</p>
            <p className={`font-bold text-lg ${cls}`}>{formatFCFA(v)}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-tertiary mt-2">{bi('Le disponible vous est versé par Tchop & Ndjoka sur votre Mobile Money (au plus une fois par jour).', 'Tchop & Ndjoka sends the available amount to your Mobile Money (at most once a day).')}</p>
      <div className="mt-3 border-t border-divider pt-3 text-sm">
        <p>{bi('Numéro de paiement', 'Payout number')} : <b className="font-mono">{m.payout_phone ?? '—'}</b></p>
        {m.payout_phone_pending && <p className="text-xs text-amber-700 mt-0.5">{bi('Nouveau numéro en attente de confirmation', 'New number waiting for confirmation')} : {m.payout_phone_pending}</p>}
        {isOwner && !edit && (
          <button type="button" onClick={() => setEdit(true)} className="mt-2 text-sm font-semibold text-brand">{bi('Changer de numéro', 'Change number')}</button>
        )}
        {isOwner && edit && (
          <form className="flex gap-2 mt-2" onSubmit={e => { e.preventDefault(); void askPhone() }}>
            <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" placeholder="+237 6…"
              aria-label={bi('Nouveau numéro Mobile Money', 'New Mobile Money number')}
              className="flex-1 min-w-0 border border-divider rounded-xl px-3 py-2 text-base outline-none focus:border-brand" />
            <button type="submit" disabled={phone.trim().length < 8} className="bg-brand disabled:opacity-50 text-white px-4 rounded-xl text-sm font-semibold">{bi('Envoyer', 'Send')}</button>
          </form>
        )}
        {msg && <p className={`mt-2 text-xs ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}
      </div>
      {m.payouts.length > 0 && (
        <ul className="mt-3 border-t border-divider pt-3 space-y-1 text-sm">
          {m.payouts.map(p => (
            <li key={p.id} className="flex justify-between gap-2">
              <span className="text-ink-secondary">{p.day} · {p.status === 'completed' ? bi('Versé', 'Paid') : p.status === 'failed' ? bi('Échoué', 'Failed') : bi('En cours', 'Sending')}</span>
              <b>{formatFCFA(Number(p.amount))}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
