'use client'

// The check screen for a scanned QR (Q2) — on /scan/<token> and in the
// in-app scanner (Q3). Staff: what it is + one big button, then a green ✓.
// Already used / refused: red, no button. Owner: their own item. Anyone else:
// neutral, no personal data.

import Link from 'next/link'
import { QRCodeSVG } from 'qrcode.react'
import { useBi, useLanguage, pickBi } from '@/lib/languageContext'

export interface ScanViewClient {
  kind: 'reservation' | 'order' | 'voucher'
  access: 'staff' | 'owner' | 'none'
  state?: 'ready' | 'used' | 'refused'
  action?: 'checkin' | 'handover' | 'redeem'
  reason?: string
  usedAt?: string
  usedBy?: string
  details?: { title: string; subtitle?: string; code: string; lines: string[]; people?: number; dayLabel?: string }
  restaurants?: Array<{ id: string; name: string }>
  loggedIn?: boolean
  ok?: boolean
  error?: string
}

export default function ScanResultCard({ view, done, busy, onRedeem, loginHref, ownQrUrl, restaurantId, onRestaurant }: {
  view: ScanViewClient
  done?: boolean                 // the button was just pressed and it worked
  busy?: boolean
  onRedeem?: () => void
  loginHref?: string
  ownQrUrl?: string              // the owner's view shows this page's QR
  restaurantId?: string
  onRestaurant?: (id: string) => void
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const t = (s?: string) => pickBi(s ?? '', locale)
  const time = (iso?: string) => iso ? new Date(iso).toLocaleTimeString(locale === 'en' ? 'en-GB' : 'fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''
  const d = view.details

  if (view.access === 'none') {
    const who = view.kind === 'reservation'
      ? bi('Ce billet ne peut être validé que par l\'organisateur.', 'Only the organiser can check this ticket.')
      : view.kind === 'order'
        ? bi('Cette commande ne peut être remise que par le restaurant.', 'Only the restaurant can hand over this order.')
        : bi('Ce bon ne peut être utilisé que par le restaurant.', 'Only the restaurant can redeem this voucher.')
    return (
      <div className="text-center">
        <p className="text-5xl" aria-hidden="true">🔒</p>
        <p className="mt-3 font-semibold text-ink-primary">{view.reason ? t(view.reason) : who}</p>
        {!view.loggedIn && loginHref && (
          <>
            <p className="mt-2 text-sm text-ink-secondary">{bi('C\'est votre billet ou votre équipe ? Connectez-vous.', 'Your ticket or your team? Log in.')}</p>
            <Link href={loginHref} className="mt-4 inline-block bg-brand hover:bg-brand-dark text-white px-6 py-3 rounded-full font-semibold">
              {bi('Se connecter', 'Log in')}
            </Link>
          </>
        )}
      </div>
    )
  }

  const doneLabel = view.kind === 'reservation'
    ? (d?.dayLabel ? `${bi('Entrée validée', 'Checked in')} · ${t(d.dayLabel)}` : bi('Entrée validée', 'Checked in'))
    : view.kind === 'order' ? bi('Remis au client', 'Handed over') : bi('Bon utilisé', 'Voucher redeemed')
  const actionLabel = view.action === 'checkin' ? bi('Valider l\'entrée', 'Check in')
    : view.action === 'handover' ? bi('Remis au client', 'Handed over') : bi('Utiliser le bon', 'Redeem')

  const banner = done
    ? { cls: 'bg-emerald-600 text-white', icon: '✓', text: doneLabel }
    : view.state === 'used'
      ? { cls: 'bg-danger text-white', icon: '✕', text: view.usedBy
          ? bi(`Déjà utilisé à ${time(view.usedAt)} par ${view.usedBy}`, `Already used at ${time(view.usedAt)} by ${view.usedBy}`)
          : bi(`Déjà utilisé à ${time(view.usedAt)}`, `Already used at ${time(view.usedAt)}`) }
      : view.state === 'refused'
        ? { cls: 'bg-danger text-white', icon: '✕', text: t(view.reason) }
        : null

  return (
    <div>
      {banner && (
        <div className={`rounded-2xl px-4 py-5 text-center ${banner.cls}`} role="status">
          <p className="text-5xl font-black leading-none" aria-hidden="true">{banner.icon}</p>
          <p className="mt-2 text-lg font-bold">{banner.text}</p>
        </div>
      )}
      {d && (
        <div className="mt-4">
          <p className="text-xl font-black text-ink-primary leading-tight">{d.title}</p>
          {d.subtitle && <p className="text-sm text-ink-secondary mt-0.5">{t(d.subtitle)}</p>}
          {d.dayLabel && !done && <p className="text-sm font-semibold text-brand-darker mt-1">{t(d.dayLabel)}</p>}
          <ul className="mt-3 space-y-1 text-ink-primary">
            {d.lines.map((l, i) => <li key={i} className={i === 0 && d.people ? 'text-2xl font-black' : 'text-sm'}>{t(l)}</li>)}
          </ul>
          <p className="mt-3 text-sm text-ink-tertiary">{bi('Code', 'Code')} <span className="font-mono font-bold text-ink-primary">#{d.code}</span></p>
        </div>
      )}
      {view.access === 'staff' && view.state === 'ready' && !done && onRedeem && (
        <>
          {view.restaurants && view.restaurants.length > 1 && (
            <label className="block mt-4 text-sm">
              <span className="text-ink-secondary">{bi('Pour quel restaurant ?', 'For which restaurant?')}</span>
              <select value={restaurantId ?? ''} onChange={e => onRestaurant?.(e.target.value)}
                className="mt-1 w-full border border-divider rounded-xl px-3 py-2.5">
                <option value="">—</option>
                {view.restaurants.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          )}
          <button type="button" onClick={onRedeem}
            disabled={busy || (!!view.restaurants && view.restaurants.length > 1 && !restaurantId)}
            className="mt-5 w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white py-5 rounded-2xl text-xl font-black transition-colors">
            {busy ? '…' : actionLabel}
          </button>
        </>
      )}
      {view.access === 'owner' && view.state === 'ready' && ownQrUrl && (
        <div className="mt-5 text-center">
          <div className="inline-block bg-white p-3 rounded-2xl border border-divider"><QRCodeSVG value={ownQrUrl} size={200} level="M" /></div>
          <p className="mt-2 text-xs text-ink-tertiary">
            {view.kind === 'reservation' ? bi('Montrez ce QR à l\'entrée.', 'Show this QR at the entrance.')
              : view.kind === 'order' ? bi('Montrez ce QR au retrait ou au livreur.', 'Show this QR at pickup or to the rider.')
                : bi('Montrez ce QR au restaurant.', 'Show this QR at the restaurant.')}
          </p>
        </div>
      )}
    </div>
  )
}
