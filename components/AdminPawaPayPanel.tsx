'use client'

// Admin → ⚙️ Plateforme → "PawaPay" (R1, R3).
//   - What PawaPay allows this account in Cameroon, per operator (MTN,
//     Orange): deposits / payouts / refunds, min, max, decimals. Read-only.
//   - "Payout test" (super admin): a small payout to a number you type, its
//     live status and how long until COMPLETED.

import { useCallback, useEffect, useState } from 'react'
import { useBi, pickBi, useLanguage } from '@/lib/languageContext'
import PhoneInput from '@/components/PhoneInput'
import { formatFCFA } from '@/lib/money'

interface Op { type: string; min: string | null; max: string | null; decimals: string | null }
interface Operator { correspondent: string; currency: string | null; operations: Op[] }
interface Config { environment: 'production' | 'sandbox'; fetched_at: string; operators: Operator[] }
interface PayoutTest { id: string; phone: string; correspondent: string | null; amount: number; status: 'pending' | 'completed' | 'failed'; pawapay_status: string | null; failure_reason: string | null; created_at: string; completed_at: string | null }

const OPS: Array<[string, string, string]> = [['DEPOSIT', 'Paiements reçus', 'Deposits'], ['PAYOUT', 'Paiements envoyés', 'Payouts'], ['REFUND', 'Remboursements', 'Refunds']]
const NAMES: Record<string, string> = { MTN_MOMO_CMR: 'MTN Mobile Money', ORANGE_CMR: 'Orange Money' }

function duration(from: string, to: string | null): string {
  if (!to) return '—'
  const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

export default function AdminPawaPayPanel() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [conf, setConf] = useState<Config | null>(null)
  const [confErr, setConfErr] = useState('')
  const [role, setRole] = useState<string | null>(null)

  const loadConf = useCallback((refresh = false) => {
    setConfErr('')
    fetch(`/api/admin/pawapay/config${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' }).then(async r => {
      const d = await r.json().catch(() => ({}))
      if (!r.ok) setConfErr(pickBi(d.error ?? 'Erreur / Error', locale) + (d.environment ? ` (${d.environment})` : ''))
      else setConf(d)
    }).catch(() => setConfErr(bi('Erreur réseau', 'Network error')))
  }, [bi, locale])
  useEffect(() => { loadConf() }, [loadConf])
  useEffect(() => { fetch('/api/auth/me').then(r => r.json()).then(d => setRole(d?.user?.role ?? null)).catch(() => null) }, [])

  return (
    <section className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-bold text-ink-primary">💳 PawaPay</h2>
        <button type="button" onClick={() => loadConf(true)} className="text-xs font-semibold text-brand-darker">↻ {bi('Actualiser', 'Refresh')}</button>
      </div>
      {confErr && <p className="text-sm text-danger">{confErr}</p>}
      {conf && (
        <>
          <p className="text-xs text-ink-tertiary">
            {bi('Compte', 'Account')} <strong className={conf.environment === 'production' ? 'text-green-700' : 'text-amber-700'}>{conf.environment}</strong> · {bi('Cameroun', 'Cameroon')} · {new Date(conf.fetched_at).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR')}
          </p>
          {conf.operators.length === 0 && <p className="text-sm text-ink-secondary">{bi('Aucun opérateur actif pour le Cameroun.', 'No active operator for Cameroon.')}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {conf.operators.map(op => (
              <div key={op.correspondent} className="rounded-xl border border-divider p-3">
                <p className="text-sm font-bold text-ink-primary">{NAMES[op.correspondent] ?? op.correspondent} <span className="text-xs font-normal text-ink-tertiary">{op.currency ?? ''}</span></p>
                <table className="w-full mt-2 text-xs">
                  <thead><tr className="text-ink-tertiary text-left"><th className="font-medium py-1"></th><th className="font-medium">Min</th><th className="font-medium">Max</th><th className="font-medium">{bi('Décimales', 'Decimals')}</th></tr></thead>
                  <tbody>
                    {OPS.map(([type, fr, en]) => {
                      const o = op.operations.find(x => x.type === type)
                      return (
                        <tr key={type} className="border-t border-divider">
                          <td className="py-1.5 font-semibold">{o ? '✅' : '❌'} {bi(fr, en)}</td>
                          <td>{o?.min ?? '—'}</td><td>{o?.max ?? '—'}</td><td>{o?.decimals ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </>
      )}
      {role === 'super_admin' && <PayoutTestBox />}
    </section>
  )
}

function PayoutTestBox() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [phone, setPhone] = useState('')
  const [amount, setAmount] = useState('100')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tests, setTests] = useState<PayoutTest[]>([])
  const [max, setMax] = useState(500)
  const [live, setLive] = useState<PayoutTest | null>(null)
  const [, tick] = useState(0)

  const load = useCallback(() => {
    fetch('/api/admin/pawapay/payout-test', { cache: 'no-store' }).then(r => r.json()).then(d => { setTests(d.tests ?? []); if (d.max) setMax(d.max) }).catch(() => null)
  }, [])
  useEffect(load, [load])

  // Live status: every 3 s until final; the clock ticks each second.
  useEffect(() => {
    if (!live || live.status !== 'pending') return
    const clock = setInterval(() => tick(n => n + 1), 1000)
    let n = 0
    const poll = setInterval(async () => {
      if (++n > 100) { clearInterval(poll); return }
      const d = await fetch(`/api/admin/pawapay/payout-test/${live.id}`, { cache: 'no-store' }).then(r => r.json()).catch(() => null)
      if (d?.test) { setLive(d.test); if (d.test.status !== 'pending') load() }
    }, 3000)
    return () => { clearInterval(clock); clearInterval(poll) }
  }, [live, load])

  async function send() {
    setBusy(true); setError('')
    const r = await fetch('/api/admin/pawapay/payout-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, amount: Number(amount) }),
    }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false); setConfirming(false)
    if (!r?.ok) { setError(pickBi(d?.error ?? 'Erreur / Error', locale)); load(); return }
    setLive(d.test); load()
  }

  const n = Math.round(Number(amount) || 0)
  return (
    <div className="border-t border-divider pt-4 space-y-3">
      <h3 className="text-sm font-bold text-ink-primary">🧪 {bi('Payout test', 'Payout test')}</h3>
      <p className="text-xs text-ink-tertiary">{bi(`Envoie un petit montant (max ${formatFCFA(max)}) à un numéro MTN ou Orange Cameroun. Argent réel en production.`, `Sends a small amount (max ${formatFCFA(max)}) to an MTN or Orange Cameroon number. Real money in production.`)}</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
        <PhoneInput value={phone} onChange={full => setPhone(full)} />
        <input type="number" inputMode="numeric" min={1} max={max} value={amount} onChange={e => setAmount(e.target.value)}
          className="border border-divider rounded-xl px-3 py-2.5 text-sm" aria-label={bi('Montant', 'Amount')} />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {!confirming ? (
        <button type="button" disabled={!phone || n < 1 || n > max || (live?.status === 'pending')} onClick={() => setConfirming(true)}
          className="bg-ink-primary text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50">{bi('Envoyer le test', 'Send the test')}</button>
      ) : (
        <div className="rounded-xl bg-rose-50 border border-danger/30 p-3 text-sm space-y-2">
          <p className="font-semibold">{bi(`Envoyer ${formatFCFA(n)} à ${phone} ?`, `Send ${formatFCFA(n)} to ${phone}?`)}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="flex-1 border border-divider bg-white py-2 rounded-lg font-semibold">{bi('Annuler', 'Cancel')}</button>
            <button type="button" onClick={send} disabled={busy} className="flex-1 bg-danger text-white py-2 rounded-lg font-bold">{busy ? '…' : bi('Confirmer', 'Confirm')}</button>
          </div>
        </div>
      )}
      {live && (
        <p className={`text-sm rounded-xl p-3 ${live.status === 'completed' ? 'bg-green-50 text-green-800' : live.status === 'failed' ? 'bg-rose-50 text-danger' : 'bg-amber-50 text-amber-800'}`}>
          {live.status === 'pending' && <>⏳ {live.pawapay_status ?? 'ACCEPTED'} · {duration(live.created_at, new Date().toISOString())}</>}
          {live.status === 'completed' && <>✅ COMPLETED {bi('en', 'in')} {duration(live.created_at, live.completed_at)}</>}
          {live.status === 'failed' && <>❌ {live.pawapay_status} · {live.failure_reason ?? '—'}</>}
        </p>
      )}
      {tests.length > 0 && (
        <ul className="text-xs divide-y divide-divider">
          {tests.map(t => (
            <li key={t.id} className="py-1.5 flex justify-between gap-2">
              <span className="truncate">{new Date(t.created_at).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR')} · {t.phone} · {NAMES[t.correspondent ?? ''] ?? t.correspondent}</span>
              <span className="flex-shrink-0 font-semibold">{formatFCFA(t.amount)} · {t.status === 'completed' ? `✅ ${duration(t.created_at, t.completed_at)}` : t.status === 'failed' ? '❌' : '⏳'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
