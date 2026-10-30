'use client'

// Admin → ⚙️ Plateforme (U1/U2): "Infos légales et contact" (the footer,
// /contact and the legal pages read these; empty = hidden) and "Demandes de
// suppression" (data deletion requests), "PawaPay" (R1: what the account
// allows; R3: payout test).

import { useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { LEGAL_FIELDS, LEGAL_LABELS, type LegalInfo, type LegalField } from '@/lib/legalInfo'
import AdminDeletionRequests from '@/components/AdminDeletionRequests'
import AdminPawaPayPanel from '@/components/AdminPawaPayPanel'

export default function AdminPlatformPage() {
  const bi = useBi()
  const [info, setInfo] = useState<LegalInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; field?: LegalField } | null>(null)
  // Legal & contact info and PawaPay: super admin only (the APIs check too);
  // deletion requests: every admin.
  const [isSuper, setIsSuper] = useState(false)

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' }).then(r => r.json()).then(d => {
      if (d?.user?.role !== 'super_admin') return
      setIsSuper(true)
      fetch('/api/admin/platform/info', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}).then(setInfo).catch(() => setInfo({}))
    }).catch(() => null)
  }, [])

  async function save() {
    setBusy(true); setMsg(null)
    const r = await fetch('/api/admin/platform/info', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(info) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (r?.ok) { setInfo(d.info); setMsg({ ok: true, text: bi('✅ Enregistré — visible sur le site d\'ici une minute', '✅ Saved — live on the site within a minute') }) }
    else setMsg({ ok: false, text: String(d?.error ?? 'Erreur / Error').split(' / ')[0], field: d?.field })
  }

  return (
    <div className="max-w-3xl space-y-6">
      {isSuper && <section className="bg-white rounded-2xl shadow-sm p-5">
        <h2 className="font-bold text-ink-primary">📄 {bi('Infos légales et contact', 'Legal & contact info')}</h2>
        <p className="text-xs text-ink-tertiary mt-1">
          {bi('Affichées dans le pied de page, sur /contact et les pages légales. Un champ vide est masqué.', 'Shown in the footer, on /contact and the legal pages. An empty field is hidden.')}
        </p>
        {!info ? <p className="mt-4 text-ink-tertiary">…</p> : (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {LEGAL_FIELDS.map(f => (
              <label key={f} className={`block ${f === 'company_address' ? 'sm:col-span-2' : ''}`}>
                <span className="text-xs font-semibold text-ink-secondary">{bi(LEGAL_LABELS[f].fr, LEGAL_LABELS[f].en)}</span>
                <input value={info[f] ?? ''} placeholder={LEGAL_LABELS[f].hint}
                  onChange={e => setInfo(i => ({ ...(i ?? {}), [f]: e.target.value }))}
                  className={`mt-1 w-full border rounded-xl px-3 py-2 text-sm outline-none focus:border-brand ${msg?.field === f ? 'border-danger' : 'border-divider'}`} />
              </label>
            ))}
          </div>
        )}
        <button type="button" onClick={save} disabled={busy || !info}
          className="mt-4 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-semibold">
          {busy ? '…' : bi('Enregistrer', 'Save')}
        </button>
        {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}
      </section>}
      <AdminDeletionRequests />
      {isSuper && <AdminPawaPayPanel />}
    </div>
  )
}
