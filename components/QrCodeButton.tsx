'use client'

// "📱 Afficher le QR" (Q1) — the customer's ticket / order / voucher QR. The
// QR is a link (https://<site>/scan/<token>) any phone camera opens; the
// short code underneath is the fallback read out loud. The QR is drawn on
// the phone (no image download), so low-data mode shows it too.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { QRCodeSVG } from 'qrcode.react'
import { useBi } from '@/lib/languageContext'

export type QrKind = 'reservation' | 'order' | 'voucher'

export default function QrCodeButton({ kind, id, title, hint, className = '' }: {
  kind: QrKind
  id: string
  title: string
  hint?: string
  className?: string
}) {
  const bi = useBi()
  const [open, setOpen] = useState(false)
  const [qr, setQr] = useState<{ url: string; code: string; delivery_code?: string; protected?: boolean } | null>(null)
  const [error, setError] = useState('')

  async function show(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation()
    setOpen(true)
    if (qr) return
    setError('')
    const r = await fetch(`/api/scan/mine?kind=${kind}&id=${id}`, { cache: 'no-store' }).catch(() => null)
    const d = r ? await r.json().catch(() => null) : null
    if (r?.ok && d?.url) setQr({ url: d.url, code: d.code, delivery_code: d.delivery_code, protected: d.protected === true })
    else setError(bi('QR indisponible pour le moment.', 'QR unavailable right now.'))
  }

  const defaultHint = kind === 'reservation'
    ? bi('Montrez ce QR à l\'entrée.', 'Show this QR at the entrance.')
    : kind === 'order'
      ? bi('Montrez ce QR au retrait ou au livreur.', 'Show this QR at pickup or to the rider.')
      : bi('Montrez ce QR au restaurant.', 'Show this QR at the restaurant.')

  return (
    <>
      <button type="button" onClick={show}
        className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-semibold bg-ink-primary text-white hover:bg-ink-secondary transition-colors ${className}`}>
        <span aria-hidden="true">📱</span>{bi('Afficher le QR', 'Show the QR')}
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}
          onClick={() => setOpen(false)}>
          <div className="bg-white rounded-3xl p-6 w-full max-w-xs text-center shadow-xl" onClick={e => e.stopPropagation()}>
            <p className="font-bold text-ink-primary">{title}</p>
            <div className="mt-4 flex items-center justify-center min-h-[240px]">
              {qr ? (
                <QRCodeSVG value={qr.url} size={240} level="M" includeMargin />
              ) : error ? (
                <p className="text-sm text-danger">{error}</p>
              ) : (
                <p className="text-sm text-ink-tertiary">{bi('Chargement…', 'Loading…')}</p>
              )}
            </div>
            {qr && (
              <p className="mt-3 text-sm text-ink-secondary">
                {bi('Code', 'Code')} <span className="font-mono font-black text-2xl tracking-widest text-ink-primary">#{qr.code}</span>
              </p>
            )}
            {qr?.delivery_code && (
              <p className="mt-2 text-sm text-ink-secondary">
                {qr.protected ? '🔐' : '🛵'} {qr.protected ? bi('Code de remise', 'Hand-over code') : bi('Code de livraison', 'Delivery code')} <span className="font-mono font-black text-xl tracking-widest text-ink-primary">{qr.delivery_code}</span>
                <span className="block text-xs text-ink-tertiary">{qr.protected
                  ? bi('Donnez ce code seulement quand vous avez votre commande.', 'Give this code only when you have your order.')
                  : bi('À donner au livreur seulement à la réception.', 'Give it to the rider only when you receive your order.')}</span>
              </p>
            )}
            <p className="mt-2 text-xs text-ink-tertiary">{hint ?? defaultHint}</p>
            <button type="button" onClick={() => setOpen(false)}
              className="mt-5 w-full border border-divider py-2.5 rounded-xl text-sm font-semibold text-ink-secondary hover:bg-surface-muted">
              {bi('Fermer', 'Close')}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
