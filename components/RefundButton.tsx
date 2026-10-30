'use client'

// R2 — "💸 Rembourser" on a paid order or a paid ticket (super admin only;
// the server checks too). Sheet: full or partial amount, reason (required),
// for a ticket "annuler la réservation" → confirm screen → PawaPay → live
// status until COMPLETED / FAILED. One refund in progress per payment, and
// never more than what was paid (server).

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBi, pickBi, useLanguage } from '@/lib/languageContext'
import { formatFCFA } from '@/lib/money'
import { formatPhoneDisplay } from '@/lib/phoneValidation'

type Kind = 'order' | 'reservation'
interface Refund { id: string; amount: number; reason: string; status: 'pending' | 'completed' | 'failed'; failure_reason: string | null; created_at: string; completed_at: string | null }
interface Info { paid: number; refunded_amount: number; refundable: number; refund_status: string; customer_phone: string | null; refunds: Refund[] }

let rolePromise: Promise<string | null> | null = null
function myRole(): Promise<string | null> {
  rolePromise ??= fetch('/api/auth/me', { cache: 'no-store' }).then(r => r.json()).then(d => d?.user?.role ?? null).catch(() => null)
  return rolePromise
}

export function RefundStatusPill({ status, refunded }: { status?: string | null; refunded?: number | null }) {
  const bi = useBi()
  if (!status || status === 'none') return null
  const map: Record<string, [string, string, string]> = {
    pending:  ['⏳ Remboursement en cours', '⏳ Refund in progress', 'bg-amber-100 text-amber-800'],
    partial:  [`💸 Remboursé en partie (${formatFCFA(refunded ?? 0)})`, `💸 Partly refunded (${formatFCFA(refunded ?? 0)})`, 'bg-sky-100 text-sky-800'],
    refunded: ['💸 Remboursé', '💸 Refunded', 'bg-gray-200 text-gray-700'],
  }
  const m = map[status]
  return m ? <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${m[2]}`}>{bi(m[0], m[1])}</span> : null
}

export default function RefundButton({ kind, id, onChanged }: { kind: Kind; id: string; onChanged?: () => void }) {
  const bi = useBi()
  const [isSuper, setIsSuper] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => { myRole().then(r => setIsSuper(r === 'super_admin')) }, [])
  if (!isSuper) return null
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-divider bg-white hover:bg-surface-muted text-ink-primary">
        💸 {bi('Rembourser', 'Refund')}
      </button>
      {open && createPortal(<RefundSheet kind={kind} id={id} onClose={() => { setOpen(false); onChanged?.() }} />, document.body)}
    </>
  )
}

function RefundSheet({ kind, id, onClose }: { kind: Kind; id: string; onClose: () => void }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [info, setInfo] = useState<Info | null>(null)
  const [mode, setMode] = useState<'full' | 'partial'>('full')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [cancel, setCancel] = useState(true)
  const [step, setStep] = useState<'form' | 'confirm' | 'tracking'>('form')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tracked, setTracked] = useState<Refund | null>(null)

  const load = () => fetch(`/api/admin/refunds?kind=${kind}&id=${id}`, { cache: 'no-store' }).then(r => r.json())
    .then(d => { if (d?.error) setError(pickBi(d.error, locale)); else setInfo(d) }).catch(() => setError(bi('Erreur réseau', 'Network error')))
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Live status after sending: every 4 s until final (max ~3 min).
  useEffect(() => {
    if (step !== 'tracking' || !tracked || tracked.status !== 'pending') return
    let n = 0
    const t = setInterval(async () => {
      if (++n > 45) { clearInterval(t); return }
      const d = await fetch(`/api/admin/refunds/${tracked.id}`, { cache: 'no-store' }).then(r => r.json()).catch(() => null)
      if (d?.refund) setTracked(d.refund)
    }, 4000)
    return () => clearInterval(t)
  }, [step, tracked])

  const pending = info?.refunds.find(r => r.status === 'pending')
  const value = mode === 'full' ? (info?.refundable ?? 0) : Math.round(Number(amount) || 0)
  const isFull = !!info && value === info.refundable && info.refunded_amount === 0

  function next() {
    setError('')
    if (!info) return
    if (value <= 0 || value > info.refundable) { setError(bi(`Montant entre 1 et ${formatFCFA(info.refundable)}.`, `Amount between 1 and ${formatFCFA(info.refundable)}.`)); return }
    if (reason.trim().length < 3) { setError(bi('La raison est requise.', 'The reason is required.')); return }
    setStep('confirm')
  }

  async function send() {
    setBusy(true); setError('')
    const r = await fetch('/api/admin/refunds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id, amount: value, reason: reason.trim(), cancel_after: kind === 'reservation' && cancel }),
    }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (!r?.ok) {
      setError(pickBi(d?.error ?? 'Erreur / Error', locale))
      if (d?.refund) { setTracked(d.refund); setStep('tracking') } else setStep('form')
      return
    }
    setTracked(d.refund); setStep('tracking')
  }

  const phone = info?.customer_phone ? (formatPhoneDisplay(info.customer_phone) || info.customer_phone) : '—'
  const input = 'w-full border border-divider rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand'
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-end md:items-center justify-center" role="dialog" aria-modal="true">
      <div className="bg-white w-full md:max-w-md max-h-[92vh] overflow-y-auto rounded-t-3xl md:rounded-2xl p-5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-lg text-ink-primary">💸 {kind === 'order' ? bi('Rembourser la commande', 'Refund the order') : bi('Rembourser le billet', 'Refund the ticket')}</h2>
          <button type="button" onClick={onClose} aria-label={bi('Fermer', 'Close')} className="w-9 h-9 rounded-full hover:bg-surface-muted text-xl">✕</button>
        </div>

        {!info ? <p className="text-sm text-ink-tertiary">{error || '…'}</p> : (
          <>
            <p className="text-sm text-ink-secondary">
              {bi('Payé', 'Paid')} <strong>{formatFCFA(info.paid)}</strong> · {bi('déjà remboursé', 'already refunded')} <strong>{formatFCFA(info.refunded_amount)}</strong> · 📱 {phone}
            </p>

            {step === 'form' && (
              pending ? (
                <p className="mt-4 rounded-xl bg-amber-50 text-amber-800 text-sm p-3">{bi('Un remboursement est déjà en cours pour ce paiement.', 'A refund is already in progress for this payment.')}</p>
              ) : info.refundable <= 0 ? (
                <p className="mt-4 rounded-xl bg-surface-muted text-sm p-3">{bi('Tout a déjà été remboursé.', 'Everything has already been refunded.')}</p>
              ) : (
                <div className="mt-4 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    {(['full', 'partial'] as const).map(m => (
                      <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
                        className={`rounded-xl border p-3 text-left text-sm ${mode === m ? 'border-brand bg-brand-light/50' : 'border-divider'}`}>
                        <span className="block font-bold">{m === 'full' ? bi('Total', 'Full') : bi('Partiel', 'Partial')}</span>
                        <span className="block text-xs text-ink-secondary">{m === 'full' ? formatFCFA(info.refundable) : bi('Montant au choix', 'Any amount')}</span>
                      </button>
                    ))}
                  </div>
                  {mode === 'partial' && (
                    <label className="block text-xs font-semibold text-ink-secondary">{bi('Montant (FCFA)', 'Amount (FCFA)')}
                      <input type="number" inputMode="numeric" min={1} max={info.refundable} value={amount} onChange={e => setAmount(e.target.value)} className={`${input} mt-1`} />
                    </label>
                  )}
                  <label className="block text-xs font-semibold text-ink-secondary">{bi('Raison * (envoyée au client)', 'Reason * (sent to the customer)')}
                    <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} maxLength={300} className={`${input} mt-1`} />
                  </label>
                  {kind === 'reservation' && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={cancel} onChange={e => setCancel(e.target.checked)} className="w-4 h-4 accent-brand" />
                      {bi('Annuler aussi la réservation (libère les places)', 'Also cancel the booking (frees the seats)')}
                    </label>
                  )}
                  {kind === 'order' && isFull && <p className="text-xs text-ink-tertiary">{bi('Un remboursement total annule la commande.', 'A full refund cancels the order.')}</p>}
                  {error && <p className="text-xs text-danger" role="alert">{error}</p>}
                  <button type="button" onClick={next} className="w-full bg-ink-primary text-white py-3 rounded-xl font-bold text-sm">{bi('Continuer', 'Continue')}</button>
                </div>
              )
            )}

            {step === 'confirm' && (
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border-2 border-danger/40 bg-rose-50 p-4 text-sm">
                  <p className="font-bold text-ink-primary">{bi(`Rembourser ${formatFCFA(value)} au ${phone} ?`, `Refund ${formatFCFA(value)} to ${phone}?`)}</p>
                  <p className="mt-1 text-ink-secondary">📝 {reason.trim()}</p>
                  {kind === 'reservation' && cancel && <p className="mt-1 text-ink-secondary">{bi('La réservation sera annulée une fois le remboursement effectué.', 'The booking is cancelled once the refund goes through.')}</p>}
                  {kind === 'order' && isFull && <p className="mt-1 text-ink-secondary">{bi('La commande sera annulée.', 'The order will be cancelled.')}</p>}
                  <p className="mt-2 text-xs font-semibold text-danger">{bi('Argent réel — irréversible.', 'Real money — cannot be undone.')}</p>
                </div>
                {error && <p className="text-xs text-danger" role="alert">{error}</p>}
                <div className="flex gap-2">
                  <button type="button" onClick={() => setStep('form')} disabled={busy} className="flex-1 border border-divider py-3 rounded-xl text-sm font-semibold">{bi('Retour', 'Back')}</button>
                  <button type="button" onClick={send} disabled={busy} className="flex-1 bg-danger text-white py-3 rounded-xl text-sm font-bold disabled:opacity-60">
                    {busy ? '…' : bi('Confirmer le remboursement', 'Confirm the refund')}
                  </button>
                </div>
              </div>
            )}

            {step === 'tracking' && tracked && (
              <div className="mt-4 space-y-3 text-sm">
                {tracked.status === 'pending' && <p className="rounded-xl bg-amber-50 text-amber-800 p-3">⏳ {bi(`Envoyé à PawaPay — en attente (${formatFCFA(tracked.amount)})…`, `Sent to PawaPay — waiting (${formatFCFA(tracked.amount)})…`)}</p>}
                {tracked.status === 'completed' && <p className="rounded-xl bg-green-50 text-green-800 p-3">✅ {bi(`Remboursé : ${formatFCFA(tracked.amount)}. Le client a reçu un WhatsApp.`, `Refunded: ${formatFCFA(tracked.amount)}. The customer got a WhatsApp.`)}</p>}
                {tracked.status === 'failed' && <p className="rounded-xl bg-rose-50 text-danger p-3">❌ {bi('Échec', 'Failed')} : {tracked.failure_reason ?? '—'}</p>}
                {error && tracked.status !== 'failed' && <p className="text-xs text-danger">{error}</p>}
                <button type="button" onClick={onClose} className="w-full border border-divider py-3 rounded-xl text-sm font-semibold">{bi('Fermer', 'Close')}</button>
              </div>
            )}

            {info.refunds.length > 0 && step !== 'tracking' && (
              <div className="mt-5">
                <p className="text-xs font-bold text-ink-secondary mb-1">{bi('Historique', 'History')}</p>
                <ul className="text-xs divide-y divide-divider">
                  {info.refunds.map(r => (
                    <li key={r.id} className="py-1.5 flex justify-between gap-2">
                      <span className="truncate">{new Date(r.created_at).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR')} · {r.reason}</span>
                      <span className="flex-shrink-0 font-semibold">{formatFCFA(r.amount)} · {r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : '⏳'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
