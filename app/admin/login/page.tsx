'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useBi } from '@/lib/languageContext'
import LanguageToggle from '@/components/LanguageToggle'

// /admin/login — the Tchop & Ndjoka team's email + password login (moved
// out of the customer login screen). On success the admin console opens on
// /account.
export default function AdminEmailLoginPage() {
  const bi = useBi()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (d?.user) window.location.replace('/account') })
      .catch(() => {})
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/auth/admin-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, rememberMe }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setError(d.error ?? bi('Identifiants incorrects', 'Incorrect credentials')); setPassword(''); return }
      window.location.href = '/account'
    } catch {
      setError(bi('Erreur réseau — réessayez.', 'Network error — please try again.'))
    } finally {
      setBusy(false)
    }
  }

  const input = 'w-full border border-divider rounded-2xl px-4 py-3 text-sm outline-none focus:border-brand'
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="absolute top-4 right-4"><LanguageToggle /></div>
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-3xl shadow-sm p-6 space-y-3" autoComplete="on">
        <div className="text-center mb-2">
          <div className="text-4xl mb-2" aria-hidden="true">🛡️</div>
          <h1 className="text-lg font-bold text-ink-primary">{bi('Équipe Tchop & Ndjoka', 'Tchop & Ndjoka team')}</h1>
        </div>
        <label className="block text-xs text-ink-secondary">{bi('E-mail', 'Email')}
          <input type="email" name="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className={`${input} mt-1`} />
        </label>
        <label className="block text-xs text-ink-secondary">{bi('Mot de passe', 'Password')}
          <input type="password" name="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className={`${input} mt-1`} />
        </label>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="w-4 h-4 rounded accent-brand" />
          <span className="text-sm text-ink-secondary">{bi('Se souvenir de moi', 'Remember me')}</span>
        </label>
        {error && <p className="text-xs text-danger" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !email.trim() || !password}
          className="w-full bg-ink-primary hover:bg-ink-secondary disabled:bg-ink-tertiary text-white py-3.5 rounded-2xl font-bold text-sm transition-colors">
          {busy ? '…' : bi('Se connecter', 'Log in')}
        </button>
        <p className="text-center pt-1">
          <Link href="/login" className="text-xs text-ink-tertiary hover:text-ink-secondary underline underline-offset-2">
            {bi('Connexion client', 'Customer login')}
          </Link>
        </p>
      </form>
    </div>
  )
}
