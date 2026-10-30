'use client'
import HelpTip from '@/components/HelpTip'

// /livraisons — "Mes livraisons" (Q5): a rider sees ONLY the orders assigned
// to them (address, landmark, customer phone, cash to collect). Their one
// action: scan the customer's QR or type the customer's delivery code →
// "Livrée". Nothing else: no menu, settings, team, money or other orders.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import TopNav from '@/components/TopNav'
import QrScannerOverlay from '@/components/QrScannerOverlay'
import { useBi, useLanguage, pickBi } from '@/lib/languageContext'
import { formatFCFA } from '@/lib/money'

interface RiderOrder {
  id: string; number: string; restaurant: string; status: string; customer_name: string | null
  phone: string | null; address: string | null; landmark: string | null
  items: Array<{ name: string; quantity: number }> | null; cash: number; delivered_at: string | null
}

export default function RiderPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [data, setData] = useState<{ rider: boolean; orders: RiderOrder[] } | null>(null)
  const [loggedOut, setLoggedOut] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetch('/api/rider/orders', { cache: 'no-store' }).catch(() => null)
    if (r?.status === 401) { setLoggedOut(true); return }
    const d = r ? await r.json().catch(() => null) : null
    setData(d ?? { rider: false, orders: [] })
  }, [])
  useEffect(() => { void load() }, [load])

  async function deliver(o: RiderOrder) {
    setBusy(o.id)
    const r = await fetch(`/api/rider/orders/${o.id}/deliver`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: codes[o.id] ?? '' }),
    }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(null)
    setMsg(m => ({ ...m, [o.id]: r?.ok ? { ok: true, text: bi('Livrée ✓', 'Delivered ✓') } : { ok: false, text: pickBi(d?.error ?? 'Erreur / Error', locale) } }))
    if (r?.ok) void load()
  }

  const open = (data?.orders ?? []).filter(o => !o.delivered_at && o.status !== 'delivered')
  const done = (data?.orders ?? []).filter(o => o.delivered_at || o.status === 'delivered')

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-md mx-auto px-4 pt-5 pb-28">
        <h1 className="text-xl font-black text-ink-primary">🛵 {bi('Mes livraisons', 'My deliveries')} <HelpTip id="deliveries" /></h1>
        {loggedOut ? (
          <p className="mt-4 text-sm text-ink-secondary">
            {bi('Connectez-vous avec votre numéro de livreur.', 'Log in with your rider number.')}{' '}
            <Link href="/login?return=%2Flivraisons" className="underline font-semibold">{bi('Se connecter', 'Log in')}</Link>
          </p>
        ) : !data ? (
          <p className="mt-4 text-ink-tertiary">…</p>
        ) : !data.rider ? (
          <p className="mt-4 text-sm text-ink-secondary">{bi('Vous n\'êtes livreur pour aucun restaurant.', 'You are not a rider for any restaurant.')}</p>
        ) : (
          <>
            <button type="button" onClick={() => setScanning(true)}
              className="mt-4 w-full bg-ink-primary hover:bg-ink-secondary text-white py-3.5 rounded-2xl font-bold">
              📷 {bi('Scanner le QR du client', 'Scan the customer\'s QR')}
            </button>
            {scanning && <QrScannerOverlay onClose={() => { setScanning(false); void load() }} />}
            {open.length === 0 && <p className="mt-6 text-sm text-ink-tertiary text-center">{bi('Aucune livraison en cours.', 'No delivery right now.')}</p>}
            <ul className="mt-4 space-y-3">
              {open.map(o => (
                <li key={o.id} className="bg-white rounded-2xl shadow-sm p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="font-bold text-ink-primary">#{o.number} · {o.restaurant}</p>
                    {o.cash > 0
                      ? <span className="text-sm font-black text-brand-darker">💵 {formatFCFA(o.cash)}</span>
                      : <span className="text-xs font-semibold text-emerald-700">✅ {bi('Payé', 'Paid')}</span>}
                  </div>
                  <ul className="mt-1 text-sm text-ink-secondary">
                    {(o.items ?? []).map((i, k) => <li key={k}>{i.quantity}× {i.name}</li>)}
                  </ul>
                  {o.address && <p className="mt-2 text-sm">📍 {o.address}</p>}
                  {o.landmark && <p className="text-sm">🧭 {o.landmark}</p>}
                  {o.phone && (
                    <a href={`tel:${o.phone}`} className="mt-1 inline-block text-sm font-semibold text-brand-darker underline">
                      📞 {o.customer_name ? `${o.customer_name} — ` : ''}{o.phone}
                    </a>
                  )}
                  <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); void deliver(o) }}>
                    <input inputMode="numeric" maxLength={4} value={codes[o.id] ?? ''}
                      onChange={e => setCodes(c => ({ ...c, [o.id]: e.target.value.replace(/\D/g, '') }))}
                      placeholder={bi('Code du client', 'Customer code')} aria-label={bi('Code de livraison du client', 'Customer delivery code')}
                      className="flex-1 min-w-0 border border-divider rounded-xl px-3 py-2.5 font-mono text-lg tracking-widest" />
                    <button type="submit" disabled={busy === o.id || (codes[o.id] ?? '').length !== 4}
                      className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-4 rounded-xl font-bold">
                      {busy === o.id ? '…' : bi('Livrée', 'Delivered')}
                    </button>
                  </form>
                  {msg[o.id] && <p className={`mt-2 text-sm font-semibold ${msg[o.id].ok ? 'text-emerald-700' : 'text-danger'}`}>{msg[o.id].text}</p>}
                </li>
              ))}
            </ul>
            {done.length > 0 && (
              <>
                <h2 className="mt-8 text-sm font-bold text-ink-secondary">{bi('Livrées aujourd\'hui', 'Delivered today')}</h2>
                <ul className="mt-2 space-y-1 text-sm text-ink-tertiary">
                  {done.map(o => <li key={o.id}>✓ #{o.number} · {o.restaurant}</li>)}
                </ul>
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
