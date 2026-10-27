'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import TopNav from '@/components/TopNav'
import { loginHref } from '@/lib/lastPhone'
import { useBi, pickBi, useLanguage } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'
import { formatPhoneDisplay, detectCountry } from '@/lib/phoneValidation'

interface Profile { phone: string; pro_name: string | null; pro_notify_phone: string | null }

const INPUT = 'w-full bg-surface-muted border border-divider rounded-xl px-3 py-2.5 text-sm text-ink-primary outline-none focus:border-brand'

// /pro/profile — set once, used everywhere in Pro:
//   - organiser / association name: pre-fills "Créer un événement" (still
//     editable per event);
//   - an extra number for event notifications, typed any way
//     ("6 70 00 00 00", "0670000000", "+237 …"); the server normalises it to
//     +E.164 with the account's country, or explains why it can't.
export default function ProProfilePage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const { loading, canEnterPro, sessionRole, effectiveMode, setMode } = useMode()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [name, setName] = useState('')
  const [extra, setExtra] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (canEnterPro && effectiveMode !== 'pro') setMode('pro')
  }, [canEnterPro, effectiveMode, setMode])

  useEffect(() => {
    if (!canEnterPro) return
    fetch('/api/pro/profile', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (!d?.profile) return
        setProfile(d.profile)
        setName(d.profile.pro_name ?? '')
        setExtra(d.profile.pro_notify_phone ? formatPhoneDisplay(d.profile.pro_notify_phone) : '')
      })
      .catch(() => setError(bi('Erreur de chargement', 'Failed to load')))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEnterPro])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(null); setSaved(false)
    try {
      const r = await fetch('/api/pro/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pro_name: name, pro_notify_phone: extra }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setError(pickBi(d?.error ?? 'Erreur / Error', locale)); return }
      setProfile(d.profile)
      setName(d.profile.pro_name ?? '')
      // Show the number as it was saved, so a normalisation is visible.
      setExtra(d.profile.pro_notify_phone ? formatPhoneDisplay(d.profile.pro_notify_phone) : '')
      setSaved(true)
    } catch {
      setError(bi('Erreur — réessayez.', 'Error — please try again.'))
    } finally {
      setSaving(false)
    }
  }

  const dial = profile ? detectCountry(profile.phone)?.code : null

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-xl mx-auto px-4 py-6 pb-28 md:pb-10">
        {loading || (canEnterPro && !profile && !error) ? (
          <div className="py-20 text-center text-4xl animate-bounce" aria-hidden="true">🪪</div>
        ) : !canEnterPro ? (
          <div className="bg-white rounded-2xl shadow-sm p-6 text-center">
            <h1 className="text-lg font-bold text-ink-primary mb-2">{bi('Profil Pro', 'Pro profile')}</h1>
            {sessionRole ? (
              <p className="text-sm text-ink-secondary">{bi('Réservé aux comptes clients.', 'For customer accounts only.')}</p>
            ) : (
              <Link href={loginHref('/pro/profile')}
                className="inline-block bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm">
                🔐 {bi('Se connecter', 'Log in')}
              </Link>
            )}
          </div>
        ) : (
          <form onSubmit={save} className="bg-white rounded-2xl shadow-sm p-5 space-y-5">
            <div>
              <h1 className="text-xl font-bold text-ink-primary">🪪 {bi('Profil Pro', 'Pro profile')}</h1>
              <p className="text-xs text-ink-tertiary mt-1">
                {bi('Utilisé pour pré-remplir vos événements.', 'Used to pre-fill your events.')}
              </p>
            </div>

            <label className="block">
              <span className="text-xs font-semibold text-ink-secondary">
                {bi('Nom de l\'organisateur / association', 'Organiser / association name')}
              </span>
              <input className={`${INPUT} mt-1`} value={name} maxLength={80}
                onChange={e => { setName(e.target.value); setSaved(false) }}
                placeholder={bi('ex : Association Culturelle Mboa', 'e.g. Mboa Cultural Association')} />
              <span className="block text-[11px] text-ink-tertiary mt-1">
                {bi('Modifiable pour chaque événement.', 'Can be changed for each event.')}
              </span>
            </label>

            <div>
              <span className="text-xs font-semibold text-ink-secondary">{bi('Numéro du compte', 'Account number')}</span>
              <p className="mt-1 text-sm text-ink-primary bg-surface-muted rounded-xl px-3 py-2.5">
                {profile ? formatPhoneDisplay(profile.phone) : '—'}
              </p>
            </div>

            <label className="block">
              <span className="text-xs font-semibold text-ink-secondary">
                {bi('Autre numéro pour les notifications (optionnel)', 'Extra notification number (optional)')}
              </span>
              <input className={`${INPUT} mt-1`} value={extra} inputMode="tel"
                onChange={e => { setExtra(e.target.value); setSaved(false); setError(null) }}
                placeholder="6 70 00 00 00" />
              <span className="block text-[11px] text-ink-tertiary mt-1">
                {dial
                  ? bi(`Sans indicatif, nous utilisons celui de votre compte (${dial}).`, `Without a country code, we use your account's (${dial}).`)
                  : bi('Avec ou sans indicatif.', 'With or without a country code.')}
              </span>
            </label>

            {error && <p className="text-xs text-danger" role="alert">{error}</p>}
            {saved && <p className="text-xs text-emerald-700" role="status">✅ {bi('Enregistré', 'Saved')}</p>}

            <button type="submit" disabled={saving}
              className="w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white py-3 rounded-xl text-sm font-bold transition-colors">
              {saving ? '…' : bi('Enregistrer', 'Save')}
            </button>
          </form>
        )}
      </main>
    </div>
  )
}
