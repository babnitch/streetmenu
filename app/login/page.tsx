'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import TopNav from '@/components/TopNav'
import PhoneInput from '@/components/PhoneInput'
import OtpInput from '@/components/OtpInput'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useCity } from '@/lib/cityContext'
import { readSavedPhone, saveLastPhone, safeReturnPath } from '@/lib/lastPhone'
import { formatPhoneDisplay } from '@/lib/phoneValidation'

type Step = 'checking' | 'phone' | 'code' | 'name'
type Channel = 'whatsapp' | 'sms'
const CODE_LENGTH = 6

// /login — "Connexion ou inscription / Log in or sign up". One screen for
// everyone (L2):
//   1. phone with its country (+237 by default), typed any way;
//   2. code by WhatsApp (or SMS);
//   3. a NEW number is asked only for a first name, then the account exists.
// Afterwards the visitor goes back to ?return= (a same-site path: the cart,
// "Ajouter mon restaurant", an event booking…), else to Mon compte.
export default function LoginPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const { city } = useCity()

  const [step, setStep] = useState<Step>('checking')
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [fullPhone, setFullPhone] = useState('')
  const [localDigits, setLocalDigits] = useState('')
  const [country, setCountry] = useState('CM')
  const [sentTo, setSentTo] = useState<{ channel: Channel } | null>(null)
  const [code, setCode] = useState('')
  const [firstName, setFirstName] = useState('')
  const [signupPass, setSignupPass] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | Channel | 'verify' | 'name' | 'resend'>(null)
  const [error, setError] = useState('')
  const [cooldown, setCooldown] = useState(0)

  // Return target, remembered number, and "already logged in?".
  useEffect(() => {
    const ret = safeReturnPath(new URLSearchParams(window.location.search).get('return'))
    setReturnTo(ret)
    const saved = readSavedPhone()
    if (saved.phone) setFullPhone(saved.phone)
    if (saved.country) setCountry(saved.country)
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (d?.user?.role === 'customer') window.location.replace(ret ?? '/account')
        else if (d?.user) window.location.replace('/account')
        else setStep('phone')
      })
      .catch(() => setStep('phone'))
  }, [])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  // What the server normalises: the digits as typed, with their country.
  const typed = localDigits || fullPhone

  async function sendCode(channel: Channel, isResend = false) {
    if (!typed.trim()) return
    setError('')
    setBusy(isResend ? 'resend' : channel)
    try {
      const r = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: typed, country, channel, locale }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setError(d.error ?? bi('Erreur — réessayez.', 'Error — please try again.'))
        if (typeof d.retry_after === 'number' && d.reason === 'resend_cooldown') setCooldown(d.retry_after)
        return
      }
      setSentTo({ channel: d.channel === 'sms' ? 'sms' : 'whatsapp' })
      setCode('')
      setCooldown(30)
      setStep('code')
    } catch {
      setError(bi('Erreur réseau — réessayez.', 'Network error — please try again.'))
    } finally {
      setBusy(null)
    }
  }

  function done(d: { customer?: { phone: string }; isNewAccount?: boolean }) {
    if (d.customer?.phone) saveLastPhone(d.customer.phone, country)
    // A full load, so every part of the app sees the new session.
    window.location.href = returnTo ?? (d.isNewAccount ? '/account?tab=vouchers&welcome=1' : '/account')
  }

  async function verify(value?: string) {
    const c = (value ?? code).trim()
    if (c.length < CODE_LENGTH || busy) return
    setError('')
    setBusy('verify')
    try {
      const r = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: typed, country, code: c, locale }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setError(d.error ?? bi('Code incorrect', 'Incorrect code')); setCode(''); return }
      if (d.needsName && d.signupPass) {
        setSignupPass(d.signupPass)
        setStep('name')
        return
      }
      done(d)
    } catch {
      setError(bi('Erreur réseau — réessayez.', 'Network error — please try again.'))
    } finally {
      setBusy(null)
    }
  }

  async function createAccount(e: React.FormEvent) {
    e.preventDefault()
    if (!firstName.trim() || !signupPass) return
    setError('')
    setBusy('name')
    try {
      const r = await fetch('/api/auth/complete-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signupPass, name: firstName.trim(), locale, city }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setError(d.error ?? bi('Erreur — réessayez.', 'Error — please try again.'))
        if (r.status === 401) { setStep('phone'); setSignupPass(null) }
        return
      }
      done(d)
    } catch {
      setError(bi('Erreur réseau — réessayez.', 'Network error — please try again.'))
    } finally {
      setBusy(null)
    }
  }

  const card = 'max-w-md mx-auto bg-white rounded-3xl shadow-sm p-6'
  const primary = 'w-full bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-3.5 rounded-2xl font-bold text-sm transition-colors'

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="px-4 py-8 pb-28 md:pb-10">
        {step === 'checking' && <div className="py-20 text-center text-4xl animate-bounce" aria-hidden="true">👤</div>}

        {step === 'phone' && (
          <div className={card}>
            <div className="text-center mb-5">
              <div className="text-5xl mb-3" aria-hidden="true">👋</div>
              <h1 className="text-xl font-bold text-ink-primary">{bi('Connexion ou inscription', 'Log in or sign up')}</h1>
              <p className="text-sm text-ink-secondary mt-1">
                {bi('Un code vous sera envoyé pour vérifier votre numéro.', 'We\'ll send you a code to check your number.')}
              </p>
            </div>
            <form onSubmit={e => { e.preventDefault(); sendCode('whatsapp') }} className="space-y-3" autoComplete="on">
              <label className="block text-xs text-ink-secondary">{bi('Numéro de téléphone', 'Phone number')}</label>
              <PhoneInput
                value={fullPhone}
                defaultCountry={country}
                onChange={(full, meta) => { setFullPhone(full); setLocalDigits(meta.local); setCountry(meta.country.iso); setError('') }}
                autoComplete="tel"
                name="phone"
                autoFocus
                freeLocal
                wrapperClassName="rounded-2xl"
              />
              {error && <p className="text-xs text-danger" role="alert">{error}</p>}
              <button type="submit" disabled={!!busy || !typed.trim()} className={primary}>
                {busy === 'whatsapp' ? bi('Envoi…', 'Sending…') : bi('📱 Recevoir le code par WhatsApp', '📱 Get the code on WhatsApp')}
              </button>
              <button type="button" onClick={() => sendCode('sms')} disabled={!!busy || !typed.trim()}
                className="w-full text-ink-secondary hover:text-ink-primary disabled:opacity-50 text-sm font-semibold py-2 transition-colors">
                {busy === 'sms' ? bi('Envoi du SMS…', 'Sending SMS…') : bi('💬 Recevoir le code par SMS', '💬 Get the code by SMS')}
              </button>
            </form>
            <p className="text-[11px] text-ink-tertiary text-center mt-4">
              {bi('Pas encore de compte ? Il sera créé après le code.', 'No account yet? It is created after the code.')}
            </p>
          </div>
        )}

        {step === 'code' && (
          <div className={card}>
            <div className="text-center mb-5">
              <div className="text-5xl mb-3" aria-hidden="true">💬</div>
              <h1 className="text-xl font-bold text-ink-primary">{bi('Saisissez le code', 'Enter the code')}</h1>
              <p className="text-sm text-ink-secondary mt-1">
                {sentTo?.channel === 'sms' ? bi('Envoyé par SMS au', 'Sent by SMS to') : bi('Envoyé sur WhatsApp au', 'Sent on WhatsApp to')}{' '}
                <span className="font-semibold">{formatPhoneDisplay(fullPhone) || fullPhone}</span>
              </p>
            </div>
            <OtpInput value={code} onChange={setCode} onComplete={v => verify(v)} length={CODE_LENGTH} autoFocus disabled={busy === 'verify'} />
            {error && <p className="text-xs text-danger mt-3" role="alert">{error}</p>}
            <button onClick={() => verify()} disabled={!!busy || code.length < CODE_LENGTH} className={`${primary} mt-4`}>
              {busy === 'verify' ? bi('Vérification…', 'Checking…') : bi('Valider', 'Confirm')}
            </button>
            <button type="button" onClick={() => sendCode(sentTo?.channel ?? 'whatsapp', true)} disabled={!!busy || cooldown > 0}
              className="w-full text-brand-darker hover:text-brand-dark disabled:text-ink-tertiary text-sm font-semibold py-2 mt-2 transition-colors">
              {cooldown > 0 ? bi(`Renvoyer le code dans ${cooldown} s`, `Resend the code in ${cooldown} s`)
                : busy === 'resend' ? bi('Envoi…', 'Sending…') : bi('Renvoyer le code', 'Resend the code')}
            </button>
            <button type="button" onClick={() => { setStep('phone'); setError(''); setCode('') }}
              className="w-full text-ink-tertiary hover:text-ink-secondary text-sm py-2 transition-colors">
              {bi('Changer de numéro', 'Change number')}
            </button>
          </div>
        )}

        {step === 'name' && (
          <div className={card}>
            <div className="text-center mb-5">
              <div className="text-5xl mb-3" aria-hidden="true">🎉</div>
              <h1 className="text-xl font-bold text-ink-primary">{bi('Bienvenue !', 'Welcome!')}</h1>
              <p className="text-sm text-ink-secondary mt-1">{bi('Comment vous appelez-vous ?', 'What\'s your first name?')}</p>
            </div>
            <form onSubmit={createAccount} className="space-y-3">
              <input value={firstName} onChange={e => setFirstName(e.target.value)} autoFocus autoComplete="given-name" maxLength={60}
                placeholder={bi('Votre prénom', 'Your first name')}
                className="w-full border border-divider rounded-2xl px-4 py-3 text-sm outline-none focus:border-brand" />
              <p className="text-[11px] text-ink-tertiary">{bi('Le reste est facultatif, à compléter plus tard dans Mon compte.', 'Everything else is optional, later in My account.')}</p>
              {error && <p className="text-xs text-danger" role="alert">{error}</p>}
              <button type="submit" disabled={!!busy || !firstName.trim()} className={primary}>
                {busy === 'name' ? '…' : bi('Créer mon compte', 'Create my account')}
              </button>
            </form>
          </div>
        )}

        {step !== 'checking' && (
          <p className="text-center mt-6">
            <Link href="/admin/login" className="text-[11px] text-ink-tertiary hover:text-ink-secondary underline underline-offset-2">
              {bi('Équipe Tchop & Ndjoka', 'Tchop & Ndjoka team')}
            </Link>
          </p>
        )}
      </main>
    </div>
  )
}
