'use client'
import HelpTip from '@/components/HelpTip'

// "🚪 Contrôle à l'entrée" (Q4) — door staff for one event: they may scan /
// check in this event's tickets, nothing else. The organiser (or an admin,
// for managed events) adds a phone; the person gets one WhatsApp with the
// scanner link. Removing ends their access at once.

import { useCallback, useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import PhoneInput from '@/components/PhoneInput'

interface Staff { customer_id: string; name: string; phone: string }

export default function DoorStaffPanel({ eventId }: { eventId: string }) {
  const bi = useBi()
  const base = `/api/events/${eventId}/door-staff`
  const [staff, setStaff] = useState<Staff[] | null>(null)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const d = await fetch(base, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
    setStaff(Array.isArray(d?.staff) ? d.staff : [])
  }, [base])
  useEffect(() => { void load() }, [load])

  async function call(method: 'POST' | 'DELETE', body: unknown, okText: string) {
    setBusy(true); setMsg(null)
    const r = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (r?.ok) { setStaff(d.staff ?? []); setMsg({ ok: true, text: okText }); return true }
    setMsg({ ok: false, text: String(d?.error ?? 'Erreur / Error').split(' / ')[0] })
    return false
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 mb-3">
      <h4 className="font-bold text-ink-primary text-sm">🚪 {bi('Contrôle à l\'entrée', 'Door staff')} <HelpTip id="doorStaff" /></h4>
      <p className="text-xs text-ink-tertiary mt-0.5">
        {bi('Ces personnes peuvent seulement scanner les billets de cet événement (pas d\'argent, pas de modification).', 'These people can only scan this event\'s tickets (no money, no editing).')}
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {(staff ?? []).map(s => (
          <li key={s.customer_id} className="flex items-center justify-between gap-2">
            <span>{s.name} <span className="font-mono text-ink-tertiary">· {s.phone}</span></span>
            <button type="button" disabled={busy} onClick={() => call('DELETE', { customer_id: s.customer_id }, bi('Retiré', 'Removed'))}
              className="text-xs text-danger hover:underline">{bi('Retirer', 'Remove')}</button>
          </li>
        ))}
        {staff && staff.length === 0 && <li className="text-xs text-ink-tertiary">{bi('Personne pour l\'instant.', 'Nobody yet.')}</li>}
      </ul>
      <div className="mt-3 space-y-2">
        <PhoneInput value={phone} onChange={full => setPhone(full)} />
        <input value={name} onChange={e => setName(e.target.value)} placeholder={bi('Nom (facultatif)', 'Name (optional)')}
          className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand" />
        <button type="button" disabled={busy || !phone}
          onClick={async () => { if (await call('POST', { phone, name }, bi('Ajouté — un WhatsApp lui a été envoyé', 'Added — they got a WhatsApp'))) { setPhone(''); setName('') } }}
          className="w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white py-2.5 rounded-xl text-sm font-semibold">
          + {bi('Ajouter au contrôle', 'Add to the door')}
        </button>
      </div>
      {msg && <p className={`mt-2 text-xs ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}
    </div>
  )
}
