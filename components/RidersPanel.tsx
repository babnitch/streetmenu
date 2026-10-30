'use client'
import HelpTip from '@/components/HelpTip'

// Dashboard → Paramètres → "🛵 Livreurs" (Q5).
//   ( ) Mes livreurs ne sont pas sur l'app   (default) — the customer, the
//       delivery code or the restaurant confirms the delivery
//   ( ) Mes livreurs utilisent l'app — add riders by phone (one WhatsApp
//       each); assign them on delivery orders; they see only those
// Owner / manager.

import { useCallback, useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import PhoneInput from '@/components/PhoneInput'

interface Rider { id: string; name: string; phone: string }

export default function RidersPanel({ restaurantId, mode, onModeChange }: {
  restaurantId: string
  mode: 'none' | 'app'
  onModeChange: (m: 'none' | 'app') => void
}) {
  const bi = useBi()
  const base = `/api/restaurants/${restaurantId}/riders`
  const [riders, setRiders] = useState<Rider[]>([])
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const d = await fetch(base, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
    setRiders(Array.isArray(d?.riders) ? d.riders : [])
  }, [base])
  useEffect(() => { if (mode === 'app') void load() }, [mode, load])

  async function setMode(m: 'none' | 'app') {
    setBusy(true); setMsg(null)
    const r = await fetch(`/api/restaurants/${restaurantId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ riders_mode: m }),
    }).catch(() => null)
    setBusy(false)
    if (r?.ok) onModeChange(m)
    else setMsg({ ok: false, text: bi('Enregistrement impossible', 'Could not save') })
  }

  async function call(method: 'POST' | 'DELETE', body: unknown, okText: string): Promise<boolean> {
    setBusy(true); setMsg(null)
    const r = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (r?.ok) { setRiders(d.riders ?? []); setMsg({ ok: true, text: okText }); return true }
    setMsg({ ok: false, text: String(d?.error ?? 'Erreur / Error').split(' / ')[0] })
    return false
  }

  const radio = (m: 'none' | 'app', title: string, sub: string) => (
    <label className={`flex items-start gap-3 border rounded-xl p-3 cursor-pointer ${mode === m ? 'border-brand bg-brand-light/40' : 'border-divider'}`}>
      <input type="radio" name="riders_mode" checked={mode === m} disabled={busy} onChange={() => setMode(m)} className="mt-1 accent-brand" />
      <span><span className="block text-sm font-semibold text-ink-primary">{title}</span><span className="block text-xs text-ink-tertiary">{sub}</span></span>
    </label>
  )

  return (
    <section className="bg-white rounded-2xl shadow-sm p-4 mb-4">
      <h3 className="font-bold text-ink-primary">🛵 {bi('Livreurs', 'Riders')} <HelpTip id="riders" /></h3>
      <div className="mt-3 space-y-2">
        {radio('none', bi('Mes livreurs ne sont pas sur l\'app', 'My riders are not on the app'),
          bi('Le client confirme la réception (bouton ou « reçu »), ou vous tapez son code de livraison.', 'The customer confirms (button or "received"), or you type their delivery code.'))}
        {radio('app', bi('Mes livreurs utilisent l\'app', 'My riders use the app'),
          bi('Ils voient seulement les livraisons que vous leur donnez, et valident avec le QR ou le code du client.', 'They only see the deliveries you give them, and confirm with the customer\'s QR or code.'))}
      </div>
      {mode === 'app' && (
        <div className="mt-4">
          <ul className="space-y-1 text-sm">
            {riders.map(r => (
              <li key={r.id} className="flex items-center justify-between gap-2">
                <span>🛵 {r.name} <span className="font-mono text-ink-tertiary">· {r.phone}</span></span>
                <button type="button" disabled={busy} onClick={() => call('DELETE', { rider_id: r.id }, bi('Retiré', 'Removed'))}
                  className="text-xs text-danger hover:underline">{bi('Retirer', 'Remove')}</button>
              </li>
            ))}
            {riders.length === 0 && <li className="text-xs text-ink-tertiary">{bi('Aucun livreur.', 'No rider yet.')}</li>}
          </ul>
          <div className="mt-3 space-y-2">
            <PhoneInput value={phone} onChange={full => setPhone(full)} />
            <input value={name} onChange={e => setName(e.target.value)} placeholder={bi('Nom (facultatif)', 'Name (optional)')}
              className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand" />
            <button type="button" disabled={busy || !phone}
              onClick={async () => { if (await call('POST', { phone, name }, bi('Ajouté — un WhatsApp lui a été envoyé', 'Added — they got a WhatsApp'))) { setPhone(''); setName('') } }}
              className="w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white py-2.5 rounded-xl text-sm font-semibold">
              + {bi('Ajouter un livreur', 'Add a rider')}
            </button>
          </div>
        </div>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}
    </section>
  )
}
