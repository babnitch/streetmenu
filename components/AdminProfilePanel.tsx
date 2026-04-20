'use client'

import { useEffect, useState, useCallback } from 'react'
import { useBi } from '@/lib/languageContext'

export interface AdminProfile {
  id: string
  name: string
  email: string
  role: 'super_admin' | 'admin' | 'moderator'
  status: 'active' | 'suspended'
  created_at: string
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  admin:       'Admin',
  moderator: 'Modérateur / Moderator',
}

function useToast() {
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const show = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }, [])
  return { toast, show }
}

export default function AdminProfilePanel() {
  const bi = useBi()
  const { toast, show: showToast } = useToast()

  const [profile, setProfile] = useState<AdminProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const [editing, setEditing] = useState(false)
  const [name,    setName]    = useState('')
  const [saving,  setSaving]  = useState(false)

  const [currentPw,  setCurrentPw]  = useState('')
  const [newPw,      setNewPw]      = useState('')
  const [confirmPw,  setConfirmPw]  = useState('')
  const [pwError,    setPwError]    = useState('')
  const [pwSaving,   setPwSaving]   = useState(false)

  useEffect(() => {
    ;(async () => {
      const res = await fetch('/api/auth/admin-profile', { cache: 'no-store' })
      const data = await res.json()
      if (data.profile) {
        setProfile(data.profile)
        setName(data.profile.name ?? '')
      }
      setLoading(false)
    })()
  }, [])

  async function handleSaveName() {
    if (!name.trim()) { showToast(bi('Nom requis', 'Name required'), false); return }
    setSaving(true)
    try {
      const res = await fetch('/api/auth/admin-update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (res.ok) {
        setProfile(p => (p ? { ...p, name: data.profile?.name ?? name } : p))
        setEditing(false)
        showToast(bi('✅ Profil mis à jour', 'Profile updated'))
      } else {
        showToast(data.error ?? bi('Erreur', 'Error'), false)
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwError('')

    if (newPw.length < 8) {
      setPwError(bi('Le nouveau mot de passe doit contenir au moins 8 caractères', 'New password must be at least 8 characters'))
      return
    }
    if (newPw !== confirmPw) {
      setPwError(bi('Les mots de passe ne correspondent pas', 'Passwords do not match'))
      return
    }

    setPwSaving(true)
    try {
      const res = await fetch('/api/auth/admin-change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      })
      const data = await res.json()
      if (res.ok) {
        setCurrentPw(''); setNewPw(''); setConfirmPw('')
        showToast(bi('✅ Mot de passe mis à jour', 'Password updated'))
      } else {
        setPwError(data.error ?? bi('Erreur', 'Error'))
      }
    } finally {
      setPwSaving(false)
    }
  }

  if (loading) {
    return <div className="text-center py-16 text-ink-tertiary">{bi('Chargement…', 'Loading…')}</div>
  }

  if (!profile) {
    return <div className="text-center py-16 text-ink-tertiary">{bi('Profil introuvable', 'Profile not found')}</div>
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] px-5 py-3 rounded-2xl shadow-lg text-sm font-semibold text-white max-w-sm ${toast.ok ? 'bg-brand' : 'bg-danger'}`}>
          {toast.msg}
        </div>
      )}

      <h2 className="text-xl font-bold text-ink-primary">{bi('👤 Mon profil', 'My Profile')}</h2>

      {/* Profile card */}
      <div className="bg-white rounded-2xl shadow-sm p-6 space-y-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <RoleBadge role={profile.role} />
            <StatusBadge status={profile.status} />
          </div>
          {editing ? (
            <div className="flex gap-2">
              <button
                onClick={handleSaveName}
                disabled={saving}
                className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors"
              >
                {saving ? '…' : bi('Enregistrer', 'Save')}
              </button>
              <button
                onClick={() => { setEditing(false); setName(profile.name) }}
                className="bg-surface-muted hover:bg-divider text-ink-primary text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors"
              >
                {bi('Annuler', 'Cancel')}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="bg-surface-muted hover:bg-divider text-ink-primary text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors"
            >
              ✏️ {bi('Modifier', 'Edit')}
            </button>
          )}
        </div>

        <div>
          <label className="block text-xs text-ink-tertiary mb-1">{bi('Nom', 'Name')}</label>
          {editing ? (
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
            />
          ) : (
            <p className="font-semibold text-ink-primary">{profile.name || '—'}</p>
          )}
        </div>

        <div>
          <label className="block text-xs text-ink-tertiary mb-1">
            Email <span className="text-ink-tertiary">· non modifiable / not editable</span>
          </label>
          <p className="font-semibold text-ink-primary font-mono text-sm break-all">{profile.email}</p>
        </div>

        <div>
          <label className="block text-xs text-ink-tertiary mb-1">{bi('Membre depuis', 'Member since')}</label>
          <p className="text-ink-primary text-sm">
            {new Date(profile.created_at).toLocaleDateString('fr-FR', {
              day: 'numeric', month: 'long', year: 'numeric',
            })}
          </p>
        </div>
      </div>

      {/* Change password card */}
      <form onSubmit={handleChangePassword} className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
        <h3 className="font-bold text-ink-primary">{bi('🔐 Changer le mot de passe', 'Change password')}</h3>

        <div>
          <label className="block text-xs text-ink-tertiary mb-1">{bi('Mot de passe actuel', 'Current password')}</label>
          <input
            type="password"
            value={currentPw}
            onChange={e => setCurrentPw(e.target.value)}
            autoComplete="current-password"
            className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>

        <div>
          <label className="block text-xs text-ink-tertiary mb-1">{bi('Nouveau mot de passe', 'New password')}<span className="text-ink-tertiary">· min 8</span></label>
          <input
            type="password"
            value={newPw}
            onChange={e => setNewPw(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>

        <div>
          <label className="block text-xs text-ink-tertiary mb-1">{bi('Confirmer', 'Confirm')}</label>
          <input
            type="password"
            value={confirmPw}
            onChange={e => setConfirmPw(e.target.value)}
            autoComplete="new-password"
            className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>

        {pwError && <p className="text-sm text-danger">{pwError}</p>}

        <button
          type="submit"
          disabled={pwSaving || !currentPw || !newPw || !confirmPw}
          className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white font-semibold text-sm px-4 py-2.5 rounded-xl transition-colors"
        >
          {pwSaving ? '…' : bi('Mettre à jour', 'Update')}
        </button>
      </form>
    </div>
  )
}

function RoleBadge({ role }: { role: AdminProfile['role'] }) {
  const cls = role === 'super_admin'
    ? 'bg-brand-light text-brand-darker'
    : role === 'admin'
      ? 'bg-brand-light text-brand-darker'
      : 'bg-sky-100 text-sky-700'
  return <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${cls}`}>{ROLE_LABELS[role] ?? role}</span>
}

function StatusBadge({ status }: { status: AdminProfile['status'] }) {
  const bi = useBi()
  const cls = status === 'active' ? 'bg-brand-light text-brand-darker' : 'bg-brand-light text-warning'
  const label = status === 'active' ? bi('Actif', 'Active') : bi('Suspendu', 'Suspended')
  return <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${cls}`}>{label}</span>
}
