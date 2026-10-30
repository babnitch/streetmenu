'use client'

export const dynamic = 'force-dynamic'

// Admin → 🛡 Équipe plateforme (super admin only). Add a member (name, email,
// WhatsApp number — it gets the login code —, a temporary password, role);
// edit a member's number, role, status (active / disabled) or give them a
// new temporary password. A temporary password is changed at the next
// login. Every change is in the audit log.

import { useState, useEffect } from 'react'
import { useBi, useLanguage, pickBi } from '@/lib/languageContext'
import PhoneInput from '@/components/PhoneInput'
import { formatPhoneDisplay } from '@/lib/phoneValidation'

interface TeamMember {
  id: string
  name: string
  email: string
  role: string
  status: string
  phone: string | null
  must_change_password?: boolean
  created_at: string
}

const INPUT = 'w-full border border-divider rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand'
const EMPTY = { name: '', email: '', password: '', role: 'moderator', phone: '' }

export default function AdminPlatformTeamPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [team, setTeam] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const [currentAdminId, setCurrentAdminId] = useState<string | undefined>()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  useEffect(() => {
    fetchTeam()
    fetch('/api/auth/me').then(r => r.json()).then(d => { if (d.user) setCurrentAdminId(d.user.id) })
  }, [])

  async function fetchTeam() {
    setLoading(true)
    const res = await fetch('/api/admin/team', { cache: 'no-store' })
    const data = await res.json().catch(() => ({}))
    if (data.team) setTeam(data.team)
    setLoading(false)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!form.phone) { setError(bi('Le numéro WhatsApp est requis : il reçoit le code de connexion.', 'The WhatsApp number is required: it gets the login code.')); return }
    setSaving(true)
    try {
      const res = await fetch('/api/admin/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(pickBi(data.error ?? 'Erreur / Error', locale)); return }
      setShowForm(false)
      setForm(EMPTY)
      await fetchTeam()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(member: TeamMember) {
    if (!confirm(bi(`Retirer ${member.name} ? Il ne pourra plus se connecter.`, `Remove ${member.name}? They will no longer be able to log in.`))) return
    setActionLoading(member.id + '-delete')
    await fetch(`/api/admin/team/${member.id}`, { method: 'DELETE' })
    await fetchTeam()
    setActionLoading(null)
  }

  // Removed members stay listed ("Retiré"), at the bottom.
  const activeCount = team.filter(m => m.status !== 'removed').length
  const shownTeam = [...team].sort((a, b) => Number(a.status === 'removed') - Number(b.status === 'removed'))

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink-primary">{bi('Équipe plateforme', 'Platform Team')}</h1>
          <p className="text-sm text-ink-secondary mt-0.5">{activeCount} {bi(activeCount > 1 ? 'membres' : 'membre', activeCount > 1 ? 'members' : 'member')}</p>
        </div>
        <button
          onClick={() => { setShowForm(v => !v); setError('') }}
          className="bg-brand hover:bg-brand-dark text-white px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors"
        >
          {showForm ? bi('Annuler', 'Cancel') : `+ ${bi('Ajouter', 'Add')}`}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl shadow-sm border border-brand-light p-6 mb-6">
          <h2 className="font-bold text-ink-primary mb-1">{bi('Nouveau membre', 'New member')}</h2>
          <p className="text-xs text-ink-tertiary mb-4">
            {bi('Le mot de passe est temporaire : il sera changé à la première connexion. Le code de connexion arrive sur le numéro WhatsApp.',
              'The password is temporary: it is changed at the first login. The login code goes to the WhatsApp number.')}
          </p>
          <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Nom *', 'Name *')}</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Marie Dupont" className={INPUT} required />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary font-medium mb-1.5">Email *</label>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="marie@example.com" className={INPUT} required />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Numéro WhatsApp * (reçoit le code de connexion)', 'WhatsApp number * (gets the login code)')}</label>
              <PhoneInput value={form.phone} onChange={full => setForm(f => ({ ...f, phone: full }))} />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Mot de passe temporaire *', 'Temporary password *')}</label>
              <input type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder={bi('8 caractères min.', 'Min. 8 characters')} className={INPUT} required minLength={8} autoComplete="off" />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Rôle *', 'Role *')}</label>
              <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                className={INPUT + ' bg-white'}>
                <option value="admin">Admin</option>
                <option value="moderator">{bi('Modérateur', 'Moderator')}</option>
              </select>
            </div>
            {error && <p className="sm:col-span-2 text-xs text-danger" role="alert">{error}</p>}
            <div className="sm:col-span-2">
              <button type="submit" disabled={saving}
                className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white px-6 py-2.5 rounded-xl font-semibold text-sm">
                {saving ? '…' : bi('Créer le compte', 'Create the account')}
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <p className="text-center py-12 text-ink-tertiary">…</p>
      ) : (
        <div className="space-y-3">
          {shownTeam.map(member => {
            const self = member.id === currentAdminId
            const removed = member.status === 'removed'
            const editable = !self && member.role !== 'super_admin' && !removed
            return (
              <div key={member.id} className={`bg-white rounded-2xl shadow-sm p-4 ${removed ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-ink-primary text-sm">{member.name}</p>
                      <RoleBadge role={member.role} />
                      {removed && (
                        <span className="text-xs bg-surface-muted text-ink-secondary px-2 py-0.5 rounded-full font-medium">{bi('Retiré', 'Removed')}</span>
                      )}
                      {member.status === 'suspended' && (
                        <span className="text-xs bg-brand-light text-warning px-2 py-0.5 rounded-full font-medium">{bi('Désactivé', 'Disabled')}</span>
                      )}
                      {member.must_change_password && !removed && (
                        <span className="text-xs bg-surface-muted text-ink-secondary px-2 py-0.5 rounded-full font-medium">{bi('Mot de passe temporaire', 'Temporary password')}</span>
                      )}
                    </div>
                    <p className="text-xs text-ink-tertiary">{member.email}</p>
                    <p className={`text-xs ${member.phone ? 'text-ink-tertiary' : 'text-danger font-semibold'}`}>
                      📱 {member.phone ? (formatPhoneDisplay(member.phone) || member.phone) : bi('Pas de numéro — ne peut pas se connecter', 'No number — cannot log in')}
                    </p>
                    <p className="text-xs text-ink-tertiary">{bi('Ajouté le', 'Added on')} {new Date(member.created_at).toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR')}</p>
                  </div>
                  {self ? (
                    <span className="text-xs text-ink-tertiary italic">{bi('Vous', 'You')}</span>
                  ) : editable && (
                    <div className="flex gap-2 flex-shrink-0">
                      <button onClick={() => setEditing(editing === member.id ? null : member.id)}
                        className="text-xs px-3 py-1.5 rounded-lg font-medium border border-divider bg-white hover:bg-surface-muted">
                        {editing === member.id ? bi('Fermer', 'Close') : bi('Modifier', 'Edit')}
                      </button>
                      <button onClick={() => handleDelete(member)} disabled={actionLoading === member.id + '-delete'}
                        className="text-xs bg-brand-light text-danger border border-divider px-3 py-1.5 rounded-lg font-medium">
                        {actionLoading === member.id + '-delete' ? '…' : bi('Retirer', 'Remove')}
                      </button>
                    </div>
                  )}
                </div>
                {editing === member.id && editable && (
                  <MemberEdit member={member} onSaved={async () => { setEditing(null); await fetchTeam() }} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MemberEdit({ member, onSaved }: { member: TeamMember; onSaved: () => void }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [phone, setPhone] = useState(member.phone ?? '')
  const [role, setRole] = useState(member.role)
  const [status, setStatus] = useState(member.status)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setError('')
    const body: Record<string, string> = {}
    if (phone !== (member.phone ?? '')) body.phone = phone
    if (role !== member.role) body.role = role
    if (status !== member.status) body.status = status
    if (password) body.password = password
    if (!Object.keys(body).length) { onSaved(); return }
    if (status === 'suspended' && member.status !== 'suspended'
        && !confirm(bi(`Désactiver ${member.name} ? Il ne pourra plus se connecter.`, `Disable ${member.name}? They will no longer be able to log in.`))) return
    setBusy(true)
    const res = await fetch(`/api/admin/team/${member.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null)
    const d = res ? await res.json().catch(() => ({})) : {}
    setBusy(false)
    if (!res?.ok) { setError(pickBi(d.error ?? 'Erreur / Error', locale)); return }
    onSaved()
  }

  return (
    <div className="mt-3 pt-3 border-t border-divider grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="sm:col-span-2">
        <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Numéro WhatsApp (code de connexion)', 'WhatsApp number (login code)')}</label>
        <PhoneInput value={phone} onChange={full => setPhone(full)} />
      </div>
      <div>
        <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Rôle', 'Role')}</label>
        <select value={role} onChange={e => setRole(e.target.value)} className={INPUT + ' bg-white'}>
          <option value="admin">Admin</option>
          <option value="moderator">{bi('Modérateur', 'Moderator')}</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Statut', 'Status')}</label>
        <select value={status} onChange={e => setStatus(e.target.value)} className={INPUT + ' bg-white'}>
          <option value="active">{bi('Actif', 'Active')}</option>
          <option value="suspended">{bi('Désactivé', 'Disabled')}</option>
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Nouveau mot de passe temporaire (facultatif)', 'New temporary password (optional)')}</label>
        <input type="text" value={password} onChange={e => setPassword(e.target.value)} minLength={8} autoComplete="off"
          placeholder={bi('Vide = inchangé · changé à la prochaine connexion', 'Empty = unchanged · changed at next login')} className={INPUT} />
      </div>
      {error && <p className="sm:col-span-2 text-xs text-danger" role="alert">{error}</p>}
      <div className="sm:col-span-2">
        <button type="button" onClick={save} disabled={busy}
          className="bg-ink-primary hover:bg-ink-secondary disabled:opacity-50 text-white px-5 py-2 rounded-xl font-semibold text-sm">
          {busy ? '…' : bi('Enregistrer', 'Save')}
        </button>
      </div>
    </div>
  )
}

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    super_admin: 'bg-brand-light text-brand-darker',
    admin:       'bg-brand-light text-brand-darker',
    moderator:   'bg-surface-muted text-ink-secondary',
  }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${map[role] ?? 'bg-surface-muted text-ink-secondary'}`}>
      {role.replace('_', ' ')}
    </span>
  )
}
