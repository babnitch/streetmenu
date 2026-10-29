'use client'

// /suppression-donnees (U2) — ask for your data to be deleted: a form
// (phone + reason), or WhatsApp "SUPPRIMER". Creates a request the admin
// handles (Admin → Plateforme → Demandes de suppression). Public, no login.

import { useState } from 'react'
import { PageShell } from '@/components/LegalPage'
import PhoneInput from '@/components/PhoneInput'
import { useBi, useLanguage, pickBi } from '@/lib/languageContext'
import { usePlatformInfo } from '@/lib/usePlatformInfo'
import { waLink } from '@/lib/legalInfo'

export default function DataDeletionPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const info = usePlatformInfo()
  const [phone, setPhone] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  async function send() {
    setBusy(true); setError('')
    const r = await fetch('/api/data-deletion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, reason }) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (r?.ok) setDone(true)
    else setError(pickBi(d?.error ?? 'Erreur — réessayez. / Error — please try again.', locale))
  }

  return (
    <PageShell title={bi('Suppression des données', 'Data deletion')}>
      <p className="mt-3 text-ink-secondary">
        {bi('Vous pouvez demander la suppression de votre compte et de vos données personnelles : nom, numéro, adresses de livraison, historique des messages. Les montants des commandes et des paiements sont conservés sans votre nom, pour la comptabilité.',
          'You can ask for your account and personal data to be deleted: name, number, delivery addresses, message history. Order and payment amounts are kept without your name, for accounting.')}
      </p>
      <p className="mt-2 text-sm text-ink-tertiary">
        {bi('Notre équipe traite la demande et vous confirme par WhatsApp ou SMS.', 'Our team handles the request and confirms by WhatsApp or SMS.')}
      </p>
      {done ? (
        <p className="mt-6 rounded-2xl bg-emerald-50 text-emerald-800 font-semibold p-4">
          ✅ {bi('Demande reçue. Nous la traitons rapidement.', 'Request received. We\'ll handle it soon.')}
        </p>
      ) : (
        <form className="mt-6 bg-white rounded-2xl shadow-sm p-4 space-y-3" onSubmit={e => { e.preventDefault(); void send() }}>
          <label className="block">
            <span className="text-sm font-semibold text-ink-primary">{bi('Votre numéro de téléphone', 'Your phone number')}</span>
            <div className="mt-1"><PhoneInput value={phone} onChange={full => setPhone(full)} /></div>
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-ink-primary">{bi('Raison (facultatif)', 'Reason (optional)')}</span>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={500}
              className="mt-1 w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand" />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="submit" disabled={busy || !phone}
            className="w-full bg-danger hover:opacity-90 disabled:opacity-50 text-white py-3 rounded-xl font-semibold">
            {busy ? '…' : bi('Demander la suppression', 'Request deletion')}
          </button>
        </form>
      )}
      <section className="mt-6">
        <h2 className="text-lg font-bold text-ink-primary">{bi('Par WhatsApp', 'On WhatsApp')}</h2>
        <p className="mt-2 text-sm text-ink-secondary">
          {bi('Envoyez « SUPPRIMER MES DONNÉES » depuis le numéro concerné', 'Send "DELETE MY DATA" from the number concerned')}
          {info?.support_whatsapp ? <> {bi('au', 'to')} <a className="font-semibold underline" href={waLink(info.support_whatsapp, bi('SUPPRIMER MES DONNÉES', 'DELETE MY DATA'))} target="_blank" rel="noopener noreferrer">{info.support_whatsapp}</a></> : null}.
        </p>
      </section>
    </PageShell>
  )
}
