'use client'

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useCodeChannel } from '@/lib/useCodeChannel'
import OtpInput from '@/components/OtpInput'
import CodeNotReceived from '@/components/CodeNotReceived'
import { useBi, useLanguage, pickBi } from '@/lib/languageContext'
import LanguageToggle from '@/components/LanguageToggle'
import { safeReturnPath } from '@/lib/lastPhone'

const ADMIN_ROLES = ['super_admin', 'admin', 'moderator']

// Only /admin/… pages are valid targets here.
function adminReturn(): string | null {
  const r = safeReturnPath(new URLSearchParams(window.location.search).get('return'))
  return r && r.startsWith('/admin/') ? r : null
}

// /admin/login — the Tchop & Ndjoka team login, in two steps:
//   1. email + password;
//   2. the 6-digit code sent to the team member's phone ("Pas reçu ?" after
//      30 s: resend, or by SMS);
//   3. only with a temporary password: choose their own.
// Only then is the (12-hour) team session opened. Not linked from anywhere
// public and not indexed. One browser holds one session: logging in here
// replaces a client session open in the same browser, which is said first.
export default function AdminEmailLoginPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [step, setStep] = useState<'creds' | 'code' | 'password'>('creds')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [challenge, setChallenge] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState('')
  const [channel, setChannel] = useState<'whatsapp' | 'sms'>('whatsapp')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [clientName, setClientName] = useState<string | null>(null)
  const [ticket, setTicket] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const [resending, setResending] = useState<false | 'whatsapp' | 'sms'>(false)
  const [pass, setPass] = useState<string | null>(null)
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])
  const onSms = useCallback(() => setChannel('sms'), [])
  useCodeChannel(ticket, step === 'code' && channel === 'whatsapp', onSms)

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (d?.user && ADMIN_ROLES.includes(d.user.role)) window.location.replace(adminReturn() ?? '/account')
        else if (d?.user) setClientName(d.user.name ?? '')
      })
      .catch(() => {})
  }, [])

  async function submitCreds(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/auth/admin-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setError(pickBi(d.error ?? 'Erreur / Error', locale)); setPassword(''); return }
      setChallenge(d.challenge)
      setSentTo(d.sentTo ?? '')
      setChannel(d.channel === 'sms' ? 'sms' : 'whatsapp')
      setTicket(typeof d.ticket === 'string' ? d.ticket : null)
      setCode('')
      setCooldown(30)
      setStep('code')
    } catch {
      setError(bi('Erreur réseau — réessayez.', 'Network error — please try again.'))
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(value?: string) {
    const c = (value ?? code).trim()
    if (c.length < 6 || busy || !challenge) return
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/auth/admin-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, code: c }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setError(pickBi(d.error ?? 'Erreur / Error', locale))
        setCode('')
        if (d.restart || d.locked) { setStep('creds'); setPassword(''); setChallenge(null) }
        return
      }
      if (d.step === 'set_password' && typeof d.pass === 'string') {
        setPass(d.pass); setNewPw(''); setNewPw2(''); setStep('password')
        return
      }
      window.location.href = adminReturn() ?? '/account'
    } catch {
      setError(bi('Erreur réseau — réessayez.', 'Network error — please try again.'))
    } finally {
      setBusy(false)
    }
  }

  async function resend(c: 'whatsapp' | 'sms') {
    if (!challenge || resending) return
    setResending(c); setError('')
    try {
      const r = await fetch('/api/auth/admin-resend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, channel: c }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setError(pickBi(d.error ?? 'Erreur / Error', locale))
        if (typeof d.retry_after === 'number') setCooldown(d.retry_after)
        if (d.restart || d.locked) { setStep('creds'); setPassword(''); setChallenge(null) }
        return
      }
      setChallenge(d.challenge); setSentTo(d.sentTo ?? sentTo)
      setChannel(d.channel === 'sms' ? 'sms' : 'whatsapp')
      setTicket(typeof d.ticket === 'string' ? d.ticket : null)
      setCode(''); setCooldown(30)
    } catch {
      setError(bi('Erreur réseau — réessayez.', 'Network error — please try again.'))
    } finally {
      setResending(false)
    }
  }

  async function submitNewPassword(e: React.FormEvent) {
    e.preventDefault()
    if (newPw.length < 8) { setError(bi('8 caractères minimum.', 'At least 8 characters.')); return }
    if (newPw !== newPw2) { setError(bi('Les deux mots de passe ne correspondent pas.', 'The two passwords do not match.')); return }
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/auth/admin-set-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass, newPassword: newPw }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setError(pickBi(d.error ?? 'Erreur / Error', locale))
        if (d.restart) { setStep('creds'); setPassword(''); setChallenge(null); setPass(null) }
        return
      }
      window.location.href = adminReturn() ?? '/account'
    } catch {
      setError(bi('Erreur réseau — réessayez.', 'Network error — please try again.'))
    } finally {
      setBusy(false)
    }
  }

  const input = 'w-full border border-divider rounded-2xl px-4 py-3 text-sm outline-none focus:border-brand'
  const button = 'w-full bg-ink-primary hover:bg-ink-secondary disabled:bg-ink-tertiary text-white py-3.5 rounded-2xl font-bold text-sm transition-colors'
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="absolute top-4 right-4"><LanguageToggle /></div>
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-sm p-6 space-y-3">
        <div className="text-center mb-2">
          <div className="text-4xl mb-2" aria-hidden="true">🛡️</div>
          <h1 className="text-lg font-bold text-ink-primary">{bi('Équipe Tchop & Ndjoka', 'Tchop & Ndjoka team')}</h1>
        </div>

        {clientName !== null && (
          <p className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2" role="status">
            {bi(
              `Vous êtes connecté comme client${clientName ? ` (${clientName})` : ''}. Se connecter comme équipe fermera cette session dans ce navigateur.`,
              `You are logged in as a customer${clientName ? ` (${clientName})` : ''}. Logging in as team will end that session in this browser.`,
            )}
          </p>
        )}

        {step === 'creds' ? (
          <form onSubmit={submitCreds} className="space-y-3" autoComplete="on">
            <label className="block text-xs text-ink-secondary">{bi('E-mail', 'Email')}
              <input type="email" name="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} className={`${input} mt-1`} />
            </label>
            <label className="block text-xs text-ink-secondary">{bi('Mot de passe', 'Password')}
              <input type="password" name="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className={`${input} mt-1`} />
            </label>
            {error && <p className="text-xs text-danger" role="alert">{error}</p>}
            <button type="submit" disabled={busy || !email.trim() || !password} className={button}>
              {busy ? '…' : bi('Continuer', 'Continue')}
            </button>
          </form>
        ) : step === 'password' ? (
          <form onSubmit={submitNewPassword} className="space-y-3" autoComplete="on">
            <p className="text-sm text-ink-secondary text-center">
              {bi('Première connexion : choisissez votre propre mot de passe.', 'First login: choose your own password.')}
            </p>
            <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
            <label className="block text-xs text-ink-secondary">{bi('Nouveau mot de passe (8 caractères min.)', 'New password (min. 8 characters)')}
              <input type="password" autoComplete="new-password" value={newPw} onChange={e => setNewPw(e.target.value)} className={`${input} mt-1`} minLength={8} autoFocus />
            </label>
            <label className="block text-xs text-ink-secondary">{bi('Confirmer', 'Confirm')}
              <input type="password" autoComplete="new-password" value={newPw2} onChange={e => setNewPw2(e.target.value)} className={`${input} mt-1`} minLength={8} />
            </label>
            {error && <p className="text-xs text-danger" role="alert">{error}</p>}
            <button type="submit" disabled={busy || !newPw || !newPw2} className={button}>
              {busy ? '…' : bi('Enregistrer et se connecter', 'Save and log in')}
            </button>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-secondary text-center">
              {channel === 'sms' ? bi('Code envoyé par SMS au', 'Code sent by SMS to') : bi('Code envoyé sur WhatsApp au', 'Code sent on WhatsApp to')}{' '}
              <span className="font-semibold">{sentTo}</span>
            </p>
            <OtpInput value={code} onChange={setCode} onComplete={v => submitCode(v)} length={6} autoFocus disabled={busy} />
            {error && <p className="text-xs text-danger" role="alert">{error}</p>}
            <button onClick={() => submitCode()} disabled={busy || code.length < 6} className={button}>
              {busy ? '…' : bi('Se connecter', 'Log in')}
            </button>
            <CodeNotReceived cooldown={cooldown} channel={channel} busy={resending} onResend={resend} />
            <button type="button" onClick={() => { setStep('creds'); setPassword(''); setError(''); setChallenge(null) }}
              className="w-full text-ink-tertiary hover:text-ink-secondary text-sm py-1">
              {bi('Recommencer', 'Start again')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
