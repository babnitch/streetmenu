'use client'

// Admin → Plateforme → "Demandes de suppression" (U2). Pending requests
// (web form, WhatsApp "supprimer", or added here), with "Anonymiser" (keeps
// orders and payments for accounting, removes name, phone, addresses,
// messages) or "Refuser". Confirm before anonymising.

import { useCallback, useEffect, useState } from 'react'
import { useBi, useLanguage, pickBi } from '@/lib/languageContext'
import PhoneInput from '@/components/PhoneInput'
import ConfirmModal from '@/components/ConfirmModal'

interface Req { id: string; phone: string; reason: string | null; via: string; status: string; created_at: string; handled_at: string | null; note: string | null; customers: { name: string } | null }

export default function AdminDeletionRequests() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [data, setData] = useState<{ pending: Req[]; handled: Req[] } | null>(null)
  const [confirm, setConfirm] = useState<Req | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phone, setPhone] = useState('')

  const load = useCallback(async () => {
    const d = await fetch('/api/admin/data-deletion', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
    setData(d ?? { pending: [], handled: [] })
  }, [])
  useEffect(() => { void load() }, [load])

  async function act(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true); setError(null)
    const r = await fetch('/api/admin/data-deletion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (!r?.ok) { setError(pickBi(d?.error ?? 'Erreur / Error', locale)); return false }
    await load()
    return true
  }

  const when = (iso: string) => new Date(iso).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'short', timeStyle: 'short' })

  return (
    <section className="bg-white rounded-2xl shadow-sm p-5">
      <h2 className="font-bold text-ink-primary">🗑 {bi('Demandes de suppression', 'Deletion requests')}</h2>
      {!data ? <p className="mt-3 text-ink-tertiary">…</p> : (
        <>
          {data.pending.length === 0 && <p className="mt-3 text-sm text-ink-tertiary">{bi('Aucune demande en attente.', 'No pending request.')}</p>}
          <ul className="mt-3 space-y-2">
            {data.pending.map(r => (
              <li key={r.id} className="border border-divider rounded-xl p-3 text-sm">
                <p className="font-semibold text-ink-primary">
                  <span className="font-mono">{r.phone}</span>{r.customers?.name ? ` · ${r.customers.name}` : ` · ${bi('pas de compte', 'no account')}`}
                </p>
                <p className="text-xs text-ink-tertiary">{when(r.created_at)} · {r.via === 'whatsapp' ? 'WhatsApp' : 'Web'}</p>
                {r.reason && <p className="mt-1 text-ink-secondary">« {r.reason} »</p>}
                <div className="mt-2 flex gap-2">
                  <button type="button" disabled={busy} onClick={() => { setError(null); setConfirm(r) }}
                    className="text-xs font-semibold px-3 py-1.5 rounded-full bg-danger text-white">{bi('Anonymiser', 'Anonymise')}</button>
                  <button type="button" disabled={busy} onClick={() => act({ action: 'reject', id: r.id, note: prompt(bi('Raison (facultatif)', 'Reason (optional)')) ?? '' })}
                    className="text-xs font-semibold px-3 py-1.5 rounded-full border border-divider">{bi('Refuser', 'Reject')}</button>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2 items-start">
            <div className="flex-1 min-w-0"><PhoneInput value={phone} onChange={full => setPhone(full)} /></div>
            <button type="button" disabled={busy || !phone} onClick={async () => { if (await act({ action: 'create', phone })) setPhone('') }}
              className="mt-0.5 text-xs font-semibold px-3 py-2.5 rounded-xl border border-brand text-brand-darker">+ {bi('Ajouter une demande', 'Add a request')}</button>
          </div>
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
          {data.handled.length > 0 && (
            <details className="mt-4 text-xs text-ink-tertiary">
              <summary className="cursor-pointer">{bi('Traitées', 'Handled')} ({data.handled.length})</summary>
              <ul className="mt-2 space-y-1">
                {data.handled.map(r => (
                  <li key={r.id}>{r.handled_at ? when(r.handled_at) : ''} · <span className="font-mono">{r.phone}</span> · {r.status === 'done' ? bi('anonymisé', 'anonymised') : bi('refusée', 'rejected')}{r.note ? ` — ${r.note}` : ''}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {confirm && (
        <ConfirmModal
          title={bi(`Anonymiser ${confirm.phone} ?`, `Anonymise ${confirm.phone}?`)}
          confirmLabel={bi('Anonymiser', 'Anonymise')} confirmClass="bg-danger hover:bg-danger text-white"
          busy={busy} error={error}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { if (await act({ action: 'anonymise', id: confirm.id })) setConfirm(null) }}
        >
          <p className="text-sm text-ink-secondary">
            {bi('Nom, téléphone, adresses et messages supprimés. Les commandes, réservations et paiements restent (comptabilité), sans nom. Irréversible.',
              'Name, phone, addresses and messages removed. Orders, bookings and payments stay (accounting), without a name. Cannot be undone.')}
          </p>
        </ConfirmModal>
      )}
    </section>
  )
}
