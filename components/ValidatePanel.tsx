'use client'

// "Valider / Validate" (Q2) — check a ticket, order or voucher by its code
// (the fallback when a QR can't be scanned): the same check screen and the
// same one-press validation as a scanned QR (recorded as "by code").
// Restaurant: order codes (#AB12) and voucher codes. Event: booking codes.
// The in-app scanner (Q3) lives here too.

import { useState } from 'react'
import { useBi } from '@/lib/languageContext'
import ScanResultCard, { type ScanViewClient } from '@/components/ScanResultCard'
import QrScannerOverlay from '@/components/QrScannerOverlay'

export type ValidateScope = { restaurantId: string } | { eventId: string }

export default function ValidatePanel({ scope, children }: { scope: ValidateScope; children?: React.ReactNode }) {
  const bi = useBi()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [view, setView] = useState<ScanViewClient | null>(null)
  const [done, setDone] = useState(false)
  const [restaurantId, setRestaurantId] = useState('')
  const [scanning, setScanning] = useState(false)

  async function lookup() {
    const c = code.trim()
    if (!c) return
    setBusy(true); setError(''); setView(null); setDone(false); setToken(null)
    const body = 'restaurantId' in scope ? { restaurant_id: scope.restaurantId, code: c } : { event_id: scope.eventId, code: c }
    const r = await fetch('/api/scan/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const d = r ? await r.json().catch(() => null) : null
    if (!r?.ok || !d?.token) {
      setBusy(false)
      setError(d?.error ? String(d.error) : bi('Code introuvable', 'Code not found'))
      return
    }
    setToken(d.token)
    const v = await fetch(`/api/scan/${d.token}`, { cache: 'no-store' }).then(x => x.json()).catch(() => null)
    setBusy(false)
    if (v) setView(v as ScanViewClient)
  }

  async function redeem() {
    if (!token) return
    setBusy(true)
    const r = await fetch(`/api/scan/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ via: 'code', restaurant_id: restaurantId || undefined }),
    }).catch(() => null)
    const d = r ? await r.json().catch(() => null) : null
    setBusy(false)
    if (d) setView(d as ScanViewClient)
    setDone(!!r?.ok)
  }

  function reset() { setCode(''); setView(null); setToken(null); setDone(false); setError(''); setRestaurantId('') }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <h3 className="font-bold text-ink-primary">✅ {bi('Valider', 'Validate')}</h3>
      <p className="text-xs text-ink-tertiary mt-0.5">
        {'restaurantId' in scope
          ? bi('Scannez le QR du client, ou tapez le code de sa commande (#AB12) ou de son bon.', 'Scan the customer\'s QR, or type their order code (#AB12) or voucher code.')
          : bi('Scannez le billet, ou tapez son code (#AB12).', 'Scan the ticket, or type its code (#AB12).')}
      </p>
      {children}
      <button type="button" onClick={() => setScanning(true)}
        className="mt-4 w-full bg-ink-primary hover:bg-ink-secondary text-white py-3.5 rounded-2xl font-bold text-base">
        📷 {bi('Scanner', 'Scan')}
      </button>
      {scanning && <QrScannerOverlay onClose={() => setScanning(false)} />}
      <p className="mt-4 text-xs text-ink-tertiary">{bi('Ou tapez le code :', 'Or type the code:')}</p>
      <form className="flex gap-2 mt-1" onSubmit={e => { e.preventDefault(); void lookup() }}>
        <input value={code} onChange={e => { setCode(e.target.value); setError('') }} placeholder="#AB12" autoCapitalize="characters"
          aria-label={bi('Code', 'Code')}
          className="flex-1 min-w-0 border border-divider rounded-xl px-3 py-2.5 text-base font-mono uppercase outline-none focus:border-brand" />
        <button type="submit" disabled={busy || !code.trim()}
          className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-semibold">
          {busy && !view ? '…' : bi('Vérifier', 'Check')}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-danger font-semibold">✕ {error.split(' / ')[0]}</p>}
      {view && (
        <div className="mt-4 border-t border-divider pt-4">
          <ScanResultCard view={view} done={done} busy={busy} onRedeem={redeem}
            restaurantId={restaurantId} onRestaurant={setRestaurantId} />
          <button type="button" onClick={reset} className="mt-4 w-full border border-divider py-2.5 rounded-xl text-sm font-semibold text-ink-secondary hover:bg-surface-muted">
            {bi('Suivant', 'Next')}
          </button>
        </div>
      )}
    </div>
  )
}
