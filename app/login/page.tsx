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
import { persistMode } from '@/lib/modeContext'

type Step = 'checking' | 'phone' | 'code' | 'name' | 'choose'
type Channel = 'whatsapp' | 'sms'
type ProChoice = 'restaurant' | 'event'
const CODE_LENGTH = 6
// The two Pro forms the Pro path lands on.
const PRO_FORMS: Record<ProChoice, string> = { restaurant: '/pro/restaurants/new', event: '/events/submit' }
const proChoiceFor = (path: string | null): ProChoice | null =>
  path?.startsWith(PRO_FORMS.restaurant) ? 'restaurant' : path?.startsWith(PRO_FORMS.event) ? 'event' : null

// /login — "Connexion ou inscription / Log in or sign up". One screen for
// everyone (L2):
//   1. phone with its country (+237 by default), typed any way;
//   2. code by WhatsApp (or SMS);
//   3. a NEW number is asked only for a first name, then the account exists.
// Afterwards the visitor goes back to ?return= (a same-site path: the cart,
// "Ajouter mon restaurant", an event booking…), else to Mon compte, in the
// account's saved mode (customers.default_mode).
//
// Pro path (?intent=pro, or "Créer un compte Pro" below the buttons): same
// account model. A new number also gives a business / association name and
// picks "Ajouter un restaurant" or "Organiser un événement"; the account then
// opens in Pro (saved on the account) on that form. An existing account just
// logs in and lands in Pro on the chosen form; its saved mode is unchanged.
export default function LoginPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const { city } = useCity()

  const [step, setStep] = useState<Step>('checking')
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [pro, setPro] = useState(false)
  const [proName, setProName] = useState('')
  const [choice, setChoice] = useState<ProChoice | null>(null)
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
    const q = new URLSearchParams(window.location.search)
    const ret = safeReturnPath(q.get('return'))
    setReturnTo(ret)
    setPro(q.get('intent') === 'pro')
    setChoice(proChoiceFor(ret))
    const saved = readSavedPhone()
    if (saved.phone) setFullPhone(saved.phone)
    if (saved.country) setCountry(saved.country)
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (d?.user?.role === 'customer') {
          if (q.get('intent') === 'pro') persistMode('pro')
          window.location.replace(ret ?? (q.get('intent') === 'pro' ? '/pro' : '/account'))
        }
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

  function done(d: { customer?: { phone: string }; isNewAccount?: boolean; default_mode?: string }) {
    if (d.customer?.phone) saveLastPhone(d.customer.phone, country)
    // Full loads below, so every part of the app sees the new session.
    if (pro) {
      persistMode('pro')
      const dest = d.isNewAccount && choice ? PRO_FORMS[choice] : returnTo
      if (dest) { window.location.href = dest; return }
      setStep('choose')          // existing account, no form chosen yet
      return
    }
    persistMode(d.default_mode === 'pro' ? 'pro' : 'client')
    window.location.href = returnTo ?? (d.isNewAccount ? '/account?tab=vouchers&welcome=1' : '/account')
  }

  function startPro() {
    setPro(true)
    const u = new URL(window.location.href)
    u.searchParams.set('intent', 'pro')
    window.history.replaceState({}, '', u)
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
    if (!firstName.trim() || !signupPass || (pro && (!proName.trim() || !choice))) return
    setError('')
    setBusy('name')
    try {
      const r = await fetch('/api/auth/complete-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signupPass, name: firstName.trim(), locale, city,
          ...(pro ? { pro: true, pro_name: proName.trim() } : {}),
        }),
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
              <h1 className="text-xl font-bold text-ink-primary">
                {pro ? bi('Espace Pro — connexion ou inscription', 'Pro — log in or sign up') : bi('Connexion ou inscription', 'Log in or sign up')}
              </h1>
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
            {!pro && (
              <button type="button" onClick={startPro}
                className="block w-full text-center text-sm font-semibold text-brand-darker hover:text-brand-dark mt-3">
                {bi('Vous êtes un professionnel ? Créer un compte Pro', 'Are you a business? Create a Pro account')} →
              </button>
            )}
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
              {pro && (
                <>
                  <input value={proName} onChange={e => setProName(e.target.value)} maxLength={80} autoComplete="organization"
                    placeholder={bi('Nom de votre entreprise ou association', 'Your business or association name')}
                    className="w-full border border-divider rounded-2xl px-4 py-3 text-sm outline-none focus:border-brand" />
                  <div className="grid grid-cols-2 gap-2" role="group" aria-label={bi('Que voulez-vous faire ?', 'What would you like to do?')}>
                    {(['restaurant', 'event'] as const).map(c => (
                      <button key={c} type="button" onClick={() => setChoice(c)} aria-pressed={choice === c}
                        className={`rounded-2xl border px-3 py-3 text-sm font-semibold transition-colors ${choice === c ? 'border-brand bg-brand-light text-brand-darker' : 'border-divider text-ink-secondary'}`}>
                        {c === 'restaurant' ? bi('🏪 Ajouter un restaurant', '🏪 Add a restaurant') : bi('🎉 Organiser un événement', '🎉 Organise an event')}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <p className="text-[11px] text-ink-tertiary">{bi('Le reste est facultatif, à compléter plus tard dans Mon compte.', 'Everything else is optional, later in My account.')}</p>
              {error && <p className="text-xs text-danger" role="alert">{error}</p>}
              <button type="submit" disabled={!!busy || !firstName.trim() || (pro && (!proName.trim() || !choice))} className={primary}>
                {busy === 'name' ? '…' : bi('Créer mon compte', 'Create my account')}
              </button>
            </form>
          </div>
        )}

        {step === 'choose' && (
          <div className={card}>
            <div className="text-center mb-5">
              <div className="text-5xl mb-3" aria-hidden="true">🧰</div>
              <h1 className="text-xl font-bold text-ink-primary">{bi('Que voulez-vous faire ?', 'What would you like to do?')}</h1>
            </div>
            <div className="space-y-3">
              <a href={PRO_FORMS.restaurant} className={`${primary} block text-center`}>{bi('🏪 Ajouter un restaurant', '🏪 Add a restaurant')}</a>
              <a href={PRO_FORMS.event} className={`${primary} block text-center`}>{bi('🎉 Organiser un événement', '🎉 Organise an event')}</a>
              <a href="/pro" className="block text-center text-sm text-ink-secondary hover:text-ink-primary py-2">{bi('Aller à l\'Espace Pro', 'Go to Pro home')}</a>
            </div>
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
