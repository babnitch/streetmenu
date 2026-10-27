'use client'

// Admin → Comptes → "🔐 Connexions de l'équipe": every team login attempt
// (password step, code step, success or failure and why), newest first.
// Backed by GET /api/admin/login-attempts.

import { useCallback, useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'

interface Attempt { id: string; email: string; ip: string | null; stage: 'password' | 'code'; success: boolean; reason: string | null; created_at: string }

const REASON: Record<string, [string, string]> = {
  unknown_email: ['e-mail inconnu', 'unknown email'],
  bad_password:  ['mauvais mot de passe', 'wrong password'],
  suspended:     ['compte suspendu', 'account suspended'],
  no_phone:      ['pas de numéro', 'no phone set'],
  bad_code:      ['mauvais code', 'wrong code'],
  code_expired:  ['code expiré', 'code expired'],
  code_locked:   ['code bloqué', 'code locked'],
  locked:        ['refusé (bloqué)', 'refused (locked)'],
}

export default function TeamLoginsPanel() {
  const bi = useBi()
  const [rows, setRows] = useState<Attempt[]>([])
  const [fails, setFails] = useState(0)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/login-attempts', { cache: 'no-store' })
      const d = await r.json()
      if (!r.ok) { setError(d.error ?? 'Erreur / Error'); return }
      setRows(d.attempts ?? []); setFails(d.failures24h ?? 0)
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { load() }, [load])

  const label = (a: Attempt) => a.success
    ? (a.stage === 'code' ? bi('✅ connecté', '✅ logged in') : bi('mot de passe OK, code envoyé', 'password OK, code sent'))
    : `❌ ${a.reason && REASON[a.reason] ? bi(REASON[a.reason][0], REASON[a.reason][1]) : (a.reason ?? '')}`

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-divider p-4 mb-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold text-ink-primary text-sm">🔐 {bi('Connexions de l\'équipe', 'Team logins')}</h2>
        <button type="button" onClick={() => setOpen(o => !o)} className="text-xs font-semibold text-brand hover:text-brand-dark">
          {open ? bi('Masquer', 'Hide') : bi('Voir', 'Show')}
        </button>
      </div>
      <p className={`text-xs mt-1 ${fails > 0 ? 'text-danger' : 'text-ink-tertiary'}`}>
        {bi(`Échecs sur 24 h : ${fails}`, `Failures in 24 h: ${fails}`)}
      </p>
      {error && <p className="text-xs text-danger mt-1">{error}</p>}
      {open && (
        <ul className="divide-y divide-divider mt-2">
          {rows.map(a => (
            <li key={a.id} className="py-1.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="text-ink-tertiary">{new Date(a.created_at).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="text-ink-primary">{a.email}</span>
              <span className={a.success ? 'text-emerald-700' : 'text-danger'}>{label(a)}</span>
              {a.ip && <span className="font-mono text-ink-tertiary">{a.ip}</span>}
            </li>
          ))}
          {rows.length === 0 && <li className="py-2 text-xs text-ink-tertiary">{bi('Aucune tentative.', 'No attempts.')}</li>}
        </ul>
      )}
    </div>
  )
}
