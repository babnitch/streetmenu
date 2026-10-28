'use client'

// Admin → "Demandes" (M5): pending module requests for restaurants or
// organisers, with Accepter / Refuser. Accepting switches the module on
// (with what it needs); the pro gets one WhatsApp either way. Hidden when
// there is nothing pending.

import { useCallback, useEffect, useState } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { moduleInfo, type ModuleSubject } from '@/lib/modules'

interface Req {
  id: string
  subject_type: ModuleSubject
  module: string
  created_at: string
  restaurant: { id: string; name: string; city: string } | null
  organizer: { id: string; name: string; phone: string } | null
  requester: { id: string; name: string; phone: string } | null
}

export default function AdminModuleRequests({
  subject, onDecided,
}: {
  subject: ModuleSubject
  // After an approval: the pro and its new module list (to refresh rows).
  onDecided?: (targetId: string, modules: string[] | undefined) => void
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [reqs, setReqs] = useState<Req[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    fetch(`/api/admin/module-requests?subject=${subject}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => setReqs(Array.isArray(d?.requests) ? d.requests : []))
      .catch(() => null)
  }, [subject])
  useEffect(() => { load() }, [load])

  async function decide(r: Req, approve: boolean) {
    setBusy(r.id)
    setError('')
    const res = await fetch(`/api/admin/module-requests/${r.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: approve ? 'approve' : 'decline' }),
    })
    const d = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setError(d.error ?? bi('Erreur', 'Error')); return }
    setReqs(prev => prev.filter(x => x.id !== r.id))
    if (approve) onDecided?.((r.restaurant?.id ?? r.organizer?.id)!, d.modules)
  }

  if (reqs.length === 0) return null
  return (
    <section className="bg-white rounded-2xl shadow-sm border border-amber-200 p-4 mb-4" aria-labelledby={`mreq-${subject}`}>
      <h2 id={`mreq-${subject}`} className="font-bold text-ink-primary mb-2">
        🧩 {bi('Demandes de modules', 'Module requests')} ({reqs.length})
      </h2>
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      <ul className="divide-y divide-divider">
        {reqs.map(r => {
          const info = moduleInfo(r.subject_type, r.module)
          const who = r.requester ?? r.organizer
          return (
            <li key={r.id} className="py-2.5 flex items-center justify-between gap-3 flex-wrap">
              <span className="min-w-0 text-sm">
                <span className="font-semibold text-ink-primary">{info ? (locale === 'fr' ? info.fr : info.en) : r.module}</span>
                <span className="text-ink-secondary"> — {r.restaurant ? `🏪 ${r.restaurant.name}` : `🎉 ${r.organizer?.name ?? ''}`}</span>
                {who && <span className="block text-xs text-ink-tertiary font-mono">{who.name} · {who.phone}</span>}
              </span>
              <span className="flex gap-2 flex-shrink-0">
                <button onClick={() => decide(r, true)} disabled={busy === r.id}
                  className="text-xs font-semibold bg-brand hover:bg-brand-dark disabled:opacity-60 text-white px-3 py-1.5 rounded-lg">
                  ✅ {bi('Accepter', 'Accept')}
                </button>
                <button onClick={() => decide(r, false)} disabled={busy === r.id}
                  className="text-xs font-semibold bg-white border border-divider text-ink-secondary hover:bg-surface-muted disabled:opacity-60 px-3 py-1.5 rounded-lg">
                  {bi('Refuser', 'Decline')}
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
