'use client'

// Admin restaurant card → "👥 Contacts & propriétaire" (N3).
//   Propriétaire   the owner, or "Géré par Tchop & Ndjoka";
//                  Changer le propriétaire (confirm, old owner removed or
//                  kept as manager — chosen each time) · Retirer ·
//                  Envoyer le message de bienvenue (never automatic)
//   Numéros de commande   WhatsApp numbers that receive the orders
//   Équipe         managers / staff, invitations (normal WhatsApp flow)
// All through /api/admin/restaurants/[id]/{contacts,owner,welcome}.

import { useCallback, useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import PhoneInput from '@/components/PhoneInput'
import ConfirmModal from '@/components/ConfirmModal'

interface Member { customer_id: string; role: string; name: string; phone: string }
interface Invitation { id: string; phone: string; role: string; expires_at: string }
interface Contacts {
  restaurant: { id: string; name: string; managed: boolean; whatsapp: string | null; takes_orders: boolean }
  owner: Member | null
  team: Member[]
  invitations: Invitation[]
  order_phones: string[]
}
type OldOwner = 'remove' | 'manager'

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error: string; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, error: String(data?.error ?? ''), data }
  } catch {
    return { ok: false, error: 'Réseau / Network', data: {} }
  }
}

export default function AdminRestaurantContacts({ restaurantId, onChanged }: { restaurantId: string; onChanged: () => void }) {
  const bi = useBi()
  const base = `/api/admin/restaurants/${restaurantId}`
  const [c, setC] = useState<Contacts | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [orderPhone, setOrderPhone] = useState('')
  const [invite, setInvite] = useState({ phone: '', role: 'manager' as 'manager' | 'staff' })
  const [ownerModal, setOwnerModal] = useState<null | 'change' | 'remove'>(null)
  const [ownerForm, setOwnerForm] = useState({ phone: '', name: '', old: 'manager' as OldOwner })
  const [modalError, setModalError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await call(`${base}/contacts`, 'GET')
    if (r.ok) setC(r.data as unknown as Contacts)
    else setError(r.error || bi('Chargement impossible', 'Could not load'))
  }, [base, bi])
  useEffect(() => { void load() }, [load])

  async function act(body: Record<string, unknown>, done?: string): Promise<boolean> {
    setBusy(true); setError(''); setNotice('')
    const r = await call(`${base}/contacts`, 'POST', body)
    setBusy(false)
    if (!r.ok) { setError(r.error || bi('Erreur', 'Error')); return false }
    if (done) setNotice(done)
    await load()
    return true
  }

  async function saveOwner() {
    setBusy(true); setModalError(null)
    const r = ownerModal === 'remove'
      ? await call(`${base}/owner`, 'DELETE', { old_owner: ownerForm.old })
      : await call(`${base}/owner`, 'POST', { phone: ownerForm.phone, name: ownerForm.name, old_owner: c?.owner ? ownerForm.old : undefined })
    setBusy(false)
    if (!r.ok) { setModalError(r.error || bi('Erreur', 'Error')); return }
    setOwnerModal(null)
    setOwnerForm({ phone: '', name: '', old: 'manager' })
    setNotice(ownerModal === 'remove'
      ? (r.data.orders_switched_off ? bi('Propriétaire retiré. Commandes coupées (plus de contact).', 'Owner removed. Orders switched off (no contact left).') : bi('Propriétaire retiré.', 'Owner removed.'))
      : bi('Propriétaire changé. Aucun message envoyé.', 'Owner changed. No message sent.'))
    await load()
    onChanged()
  }

  async function sendWelcome() {
    setBusy(true); setError(''); setNotice('')
    const r = await call(`${base}/welcome`, 'POST')
    setBusy(false)
    if (r.ok && r.data.sent !== false) setNotice(bi('✅ Message de bienvenue envoyé', '✅ Welcome message sent'))
    else if (r.ok) setError(bi('WhatsApp a refusé l\'envoi pour l\'instant ; nouvel essai automatique si possible (voir Messages).', 'WhatsApp refused the send for now; it is retried automatically when possible (see Messages).'))
    else setError(r.error || bi('Erreur', 'Error'))
  }

  if (!c) {
    return <div className="px-5 py-3 text-xs text-ink-tertiary">{error || bi('Chargement…', 'Loading…')}</div>
  }

  const roleLabel = (r: string) => r === 'manager' ? bi('Gérant', 'Manager') : r === 'staff' ? bi('Employé', 'Staff') : bi('Propriétaire', 'Owner')
  const btn = 'text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors disabled:opacity-50'

  return (
    <div className="px-5 py-4 space-y-4 text-sm">
      {/* Propriétaire */}
      <section>
        <h4 className="text-xs font-bold uppercase tracking-wide text-ink-tertiary mb-1.5">{bi('Propriétaire', 'Owner')}</h4>
        {c.owner ? (
          <p className="text-ink-primary">👤 <span className="font-medium">{c.owner.name}</span> <span className="font-mono text-ink-tertiary">· {c.owner.phone}</span></p>
        ) : (
          <p className="text-ink-primary">🏢 {bi('Géré par Tchop & Ndjoka', 'Managed by Tchop & Ndjoka')}</p>
        )}
        <div className="flex flex-wrap gap-2 mt-2">
          <button type="button" disabled={busy} onClick={() => { setModalError(null); setOwnerModal('change') }}
            className={`${btn} border-brand text-brand-darker hover:bg-brand-light`}>
            {c.owner ? bi('Changer le propriétaire', 'Change owner') : bi('Ajouter un propriétaire', 'Add an owner')}
          </button>
          {c.owner && (
            <>
              <button type="button" disabled={busy} onClick={sendWelcome} className={`${btn} border-divider text-ink-primary hover:bg-surface-muted`}>
                👋 {bi('Envoyer le message de bienvenue', 'Send welcome message')}
              </button>
              <button type="button" disabled={busy} onClick={() => { setModalError(null); setOwnerModal('remove') }}
                className={`${btn} border-divider text-danger hover:bg-danger/5`}>
                {bi('Retirer le propriétaire', 'Remove owner')}
              </button>
            </>
          )}
        </div>
      </section>

      {/* Numéros de commande */}
      <section>
        <h4 className="text-xs font-bold uppercase tracking-wide text-ink-tertiary mb-1.5">{bi('Numéros qui reçoivent les commandes', 'Numbers that receive orders')}</h4>
        {c.order_phones.length === 0 && (
          <p className="text-xs text-ink-tertiary">{bi('Aucun.', 'None.')}</p>
        )}
        <ul className="space-y-1">
          {c.order_phones.map(p => (
            <li key={p} className="flex items-center justify-between gap-2">
              <span className="font-mono">💬 {p}</span>
              <button type="button" disabled={busy} onClick={() => act({ action: 'remove_order_phone', phone: p })}
                className="text-xs text-danger hover:underline">{bi('Retirer', 'Remove')}</button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 mt-2 items-start">
          <div className="flex-1 min-w-0"><PhoneInput value={orderPhone} onChange={full => setOrderPhone(full)} /></div>
          <button type="button" disabled={busy || !orderPhone}
            onClick={async () => { if (await act({ action: 'add_order_phone', phone: orderPhone }, bi('Numéro ajouté', 'Number added'))) setOrderPhone('') }}
            className={`${btn} border-brand bg-brand text-white hover:bg-brand-dark mt-1`}>+ {bi('Ajouter', 'Add')}</button>
        </div>
        {c.restaurant.managed && !c.restaurant.takes_orders && (
          <p className="text-[11px] text-ink-tertiary mt-1">
            {bi('Commandes peut être activé (Modules) dès qu\'il y a un numéro ou un membre d\'équipe.', 'Orders can be switched on (Modules) once there is a number or a team member.')}
          </p>
        )}
      </section>

      {/* Équipe */}
      <section>
        <h4 className="text-xs font-bold uppercase tracking-wide text-ink-tertiary mb-1.5">{bi('Équipe', 'Team')}</h4>
        <ul className="space-y-1">
          {c.team.map(m => (
            <li key={m.customer_id} className="flex items-center justify-between gap-2">
              <span>{m.name} <span className="font-mono text-ink-tertiary">· {m.phone}</span> <span className="text-xs text-ink-secondary">· {roleLabel(m.role)}</span></span>
              <button type="button" disabled={busy} onClick={() => act({ action: 'remove_member', customer_id: m.customer_id })}
                className="text-xs text-danger hover:underline">{bi('Retirer', 'Remove')}</button>
            </li>
          ))}
          {c.invitations.map(i => (
            <li key={i.id} className="flex items-center justify-between gap-2 text-ink-secondary">
              <span><span className="font-mono">{i.phone}</span> · {roleLabel(i.role)} · <em>{bi('invitation en attente', 'invitation pending')}</em></span>
              <button type="button" disabled={busy} onClick={() => act({ action: 'cancel_invitation', id: i.id })}
                className="text-xs text-danger hover:underline">{bi('Annuler', 'Cancel')}</button>
            </li>
          ))}
          {c.team.length === 0 && c.invitations.length === 0 && <li className="text-xs text-ink-tertiary">{bi('Personne.', 'Nobody.')}</li>}
        </ul>
        <div className="flex flex-wrap gap-2 mt-2 items-start">
          <div className="flex-1 min-w-[12rem]"><PhoneInput value={invite.phone} onChange={full => setInvite(v => ({ ...v, phone: full }))} /></div>
          <select value={invite.role} onChange={e => setInvite(v => ({ ...v, role: e.target.value as 'manager' | 'staff' }))}
            className="border border-divider rounded-xl px-2 py-2 text-sm mt-0.5">
            <option value="manager">{bi('Gérant', 'Manager')}</option>
            <option value="staff">{bi('Employé', 'Staff')}</option>
          </select>
          <button type="button" disabled={busy || !invite.phone}
            onClick={async () => { if (await act({ action: 'invite_member', ...invite }, bi('Invitation envoyée sur WhatsApp', 'Invitation sent on WhatsApp'))) setInvite({ phone: '', role: 'manager' }) }}
            className={`${btn} border-brand bg-brand text-white hover:bg-brand-dark mt-1`}>{bi('Inviter', 'Invite')}</button>
        </div>
      </section>

      {error && <p className="text-xs text-danger">{error}</p>}
      {notice && <p className="text-xs text-emerald-700">{notice}</p>}

      {ownerModal === 'change' && (
        <ConfirmModal
          title={c.owner ? bi(`Changer le propriétaire de « ${c.restaurant.name} »`, `Change the owner of "${c.restaurant.name}"`) : bi(`Propriétaire de « ${c.restaurant.name} »`, `Owner of "${c.restaurant.name}"`)}
          confirmLabel={bi('Confirmer', 'Confirm')}
          confirmClass="bg-brand hover:bg-brand-dark text-white"
          busy={busy} error={modalError}
          onCancel={() => setOwnerModal(null)} onConfirm={saveOwner}
        >
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="text-xs font-semibold text-ink-secondary">{bi('Téléphone du nouveau propriétaire', 'New owner\'s phone')}</span>
              <PhoneInput value={ownerForm.phone} onChange={full => setOwnerForm(f => ({ ...f, phone: full }))} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-secondary">{bi('Nom (si nouveau numéro)', 'Name (if new number)')}</span>
              <input value={ownerForm.name} onChange={e => setOwnerForm(f => ({ ...f, name: e.target.value }))}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand" />
            </label>
            {c.owner && <OldOwnerChoice name={c.owner.name} value={ownerForm.old} onChange={old => setOwnerForm(f => ({ ...f, old }))} />}
            <p className="text-[11px] text-ink-tertiary">
              {bi('Aucun message n\'est envoyé. Utilisez ensuite « Envoyer le message de bienvenue ».', 'No message is sent. Then use "Send welcome message".')}
            </p>
          </div>
        </ConfirmModal>
      )}
      {ownerModal === 'remove' && c.owner && (
        <ConfirmModal
          title={bi(`Retirer ${c.owner.name} comme propriétaire ?`, `Remove ${c.owner.name} as owner?`)}
          confirmLabel={bi('Retirer', 'Remove')}
          confirmClass="bg-danger hover:bg-danger text-white"
          busy={busy} error={modalError}
          onCancel={() => setOwnerModal(null)} onConfirm={saveOwner}
        >
          <div className="space-y-3 text-sm">
            <OldOwnerChoice name={c.owner.name} value={ownerForm.old} onChange={old => setOwnerForm(f => ({ ...f, old }))} />
            <p className="text-[11px] text-ink-tertiary">
              {bi('Le restaurant redevient géré par Tchop & Ndjoka.', 'The restaurant goes back to being managed by Tchop & Ndjoka.')}
            </p>
          </div>
        </ConfirmModal>
      )}
    </div>
  )
}

function OldOwnerChoice({ name, value, onChange }: { name: string; value: OldOwner; onChange: (v: OldOwner) => void }) {
  const bi = useBi()
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-semibold text-ink-secondary mb-1">{bi(`Et ${name} ?`, `And ${name}?`)}</legend>
      <label className="flex items-center gap-2">
        <input type="radio" checked={value === 'manager'} onChange={() => onChange('manager')} className="accent-brand" />
        {bi('Garder comme gérant', 'Keep as manager')}
      </label>
      <label className="flex items-center gap-2">
        <input type="radio" checked={value === 'remove'} onChange={() => onChange('remove')} className="accent-brand" />
        {bi('Retirer de l\'équipe', 'Remove from the team')}
      </label>
    </fieldset>
  )
}
