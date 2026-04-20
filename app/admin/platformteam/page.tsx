'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { useBi } from '@/lib/languageContext'

interface TeamMember {
  id: string
  name: string
  email: string
  role: string
  status: string
  created_at: string
}

const INPUT = 'w-full border border-divider rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand'

export default function AdminPlatformTeamPage() {
  const bi = useBi()
  const [team, setTeam] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const [currentAdminId, setCurrentAdminId] = useState<string | undefined>()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'moderator' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  useEffect(() => {
    fetchTeam()
    fetch('/api/auth/me').then(r => r.json()).then(d => { if (d.user) setCurrentAdminId(d.user.id) })
  }, [])

  async function fetchTeam() {
    setLoading(true)
    const res = await fetch('/api/admin/team')
    const data = await res.json()
    if (data.team) setTeam(data.team)
    setLoading(false)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const res = await fetch('/api/admin/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Erreur'); return }
      setShowForm(false)
      setForm({ name: '', email: '', password: '', role: 'moderator' })
      await fetchTeam()
    } finally {
      setSaving(false)
    }
  }

  async function toggleStatus(member: TeamMember) {
    const newStatus = member.status === 'active' ? 'suspended' : 'active'
    setActionLoading(member.id + '-status')
    await fetch(`/api/admin/team/${member.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    await fetchTeam()
    setActionLoading(null)
  }

  async function handleDelete(member: TeamMember) {
    if (!confirm(bi(`Supprimer ${member.name} ?`, `Delete ${member.name}?`))) return
    setActionLoading(member.id + '-delete')
    await fetch(`/api/admin/team/${member.id}`, { method: 'DELETE' })
    await fetchTeam()
    setActionLoading(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink-primary">{bi('Équipe plateforme', 'Platform Team')}</h1>
          <p className="text-sm text-ink-secondary mt-0.5">{team.length} membre{team.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="bg-brand hover:bg-brand-dark text-white px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors"
        >
          {showForm ? 'Annuler' : '+ Ajouter'}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl shadow-sm border border-brand-light p-6 mb-6">
          <h2 className="font-bold text-ink-primary mb-4">{bi('Nouveau membre', 'New member')}</h2>
          <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Nom', 'Name *')}</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Marie Dupont" className={INPUT} required />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary font-medium mb-1.5">Email *</label>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="marie@example.com" className={INPUT} required />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Mot de passe', 'Password *')}</label>
              <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder="Min. 8 caractères" className={INPUT} required minLength={8} />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary font-medium mb-1.5">{bi('Rôle', 'Role *')}</label>
              <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                className={INPUT + ' bg-white'}>
                <option value="admin">Admin</option>
                <option value="moderator">{bi('Modérateur', 'Moderator')}</option>
              </select>
            </div>
            {error && <p className="sm:col-span-2 text-xs text-danger">{error}</p>}
            <div className="sm:col-span-2 flex gap-3 mt-1">
              <button type="submit" disabled={saving}
                className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors">
                {saving ? 'Enregistrement…' : bi('Ajouter', 'Add')}
              </button>
              <button type="button" onClick={() => setShowForm(false)}
                className="text-sm text-ink-secondary hover:text-ink-primary px-4">
                Annuler
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3 animate-bounce">👥</div>
          <p>Chargement…</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {team.map((member, idx) => (
            <div
              key={member.id}
              className={`flex items-center gap-4 px-5 py-4 ${idx < team.length - 1 ? 'border-b border-divider' : ''}`}
            >
              <div className="w-10 h-10 rounded-xl bg-surface-muted flex items-center justify-center flex-shrink-0 text-lg font-bold text-ink-secondary">
                {member.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-ink-primary text-sm">{member.name}</p>
                  <RoleBadge role={member.role} />
                  {member.status === 'suspended' && (
                    <span className="text-xs bg-brand-light text-warning px-2 py-0.5 rounded-full font-medium">Suspendu</span>
                  )}
                </div>
                <p className="text-xs text-ink-tertiary">{member.email}</p>
                <p className="text-xs text-ink-tertiary">Ajouté le {new Date(member.created_at).toLocaleDateString('fr-FR')}</p>
              </div>
              {member.id !== currentAdminId && (
                <div className="flex gap-2">
                  <button
                    onClick={() => toggleStatus(member)}
                    disabled={actionLoading === member.id + '-status'}
                    className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors border ${
                      member.status === 'active'
                        ? 'bg-brand-light text-warning border-divider hover:bg-brand-light'
                        : 'bg-brand-light text-brand-darker border-divider hover:bg-brand-light'
                    }`}
                  >
                    {actionLoading === member.id + '-status' ? '…' : (member.status === 'active' ? 'Suspendre' : 'Réactiver')}
                  </button>
                  <button
                    onClick={() => handleDelete(member)}
                    disabled={actionLoading === member.id + '-delete'}
                    className="text-xs bg-brand-light text-danger border border-divider px-3 py-1.5 rounded-lg font-medium hover:bg-brand-light transition-colors"
                  >
                    {actionLoading === member.id + '-delete' ? '…' : 'Supprimer'}
                  </button>
                </div>
              )}
              {member.id === currentAdminId && (
                <span className="text-xs text-ink-tertiary italic">{bi('Vous', 'You')}</span>
              )}
            </div>
          ))}
        </div>
      )}
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
