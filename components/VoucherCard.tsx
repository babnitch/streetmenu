'use client'

import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Voucher } from '@/types'
import { useLanguage } from '@/lib/languageContext'

interface VoucherCardProps {
  voucher: Voucher
  customerVoucherId: string
  usedAt?: string | null
}

export default function VoucherCard({ voucher, customerVoucherId, usedAt }: VoucherCardProps) {
  const { t } = useLanguage()
  const [showModal, setShowModal] = useState(false)

  const isUsed = !!usedAt
  const isExpired = voucher.expires_at ? new Date(voucher.expires_at) < new Date() : false
  const isActive = !isUsed && !isExpired && voucher.is_active

  const discountLabel = voucher.discount_type === 'percent'
    ? `-${voucher.discount_value}%`
    : `-${Number(voucher.discount_value).toLocaleString()} FCFA`

  const expiryStr = voucher.expires_at
    ? new Date(voucher.expires_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
    : null

  return (
    <>
      {/* Compact card */}
      <div className={`relative bg-white rounded-2xl shadow-sm border overflow-hidden ${
        isUsed ? 'border-divider opacity-60' : isExpired ? 'border-divider opacity-70' : 'border-brand-light'
      }`}>
        {/* Left accent strip */}
        <div className={`absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl ${
          isActive ? 'bg-brand' : 'bg-divider'
        }`} />

        <div className="pl-5 pr-4 py-4 flex items-center gap-4">
          {/* Discount amount */}
          <div className={`flex-shrink-0 w-14 h-14 rounded-xl flex items-center justify-center font-black text-lg ${
            isActive ? 'bg-brand-light text-brand' : 'bg-surface-muted text-ink-tertiary'
          }`}>
            {discountLabel}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <p className={`font-mono font-bold text-base tracking-widest ${isActive ? 'text-ink-primary' : 'text-ink-tertiary'}`}>
              {voucher.code}
            </p>
            <p className="text-xs text-ink-tertiary mt-0.5">
              {expiryStr ? `${t('voucher.expiry')} ${expiryStr}` : t('voucher.noExpiry')}
            </p>
          </div>

          {/* Status + QR button */}
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              isUsed ? 'bg-surface-muted text-ink-secondary' :
              isExpired ? 'bg-brand-light text-danger' :
              'bg-brand-light text-brand-darker'
            }`}>
              {isUsed ? t('voucher.used') : isExpired ? t('voucher.expired') : t('voucher.active')}
            </span>
            {isActive && (
              <button
                onClick={() => setShowModal(true)}
                className="text-xs text-brand hover:text-brand-dark font-semibold underline"
              >
                {t('voucher.viewBtn')}
              </button>
            )}
          </div>
        </div>

        {/* Dashed separator + QR preview */}
        {isActive && (
          <div className="border-t border-dashed border-brand-light mx-4 mb-3 pt-3 flex items-center justify-between">
            <p className="text-xs text-ink-tertiary">{t('voucher.present')}</p>
            <div className="bg-white p-1 rounded-lg border border-brand-light">
              <QRCodeSVG value={customerVoucherId} size={40} />
            </div>
          </div>
        )}
      </div>

      {/* Full-screen modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setShowModal(false)}>
          <div
            className="bg-white rounded-3xl p-6 w-full max-w-sm text-center shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* NT header */}
            <div className="flex items-center justify-center gap-2 mb-5">
              <span className="bg-brand text-white font-black text-sm px-2 py-1 rounded-lg tracking-tight">NT</span>
              <span className="font-bold text-ink-primary">Ndjoka &amp; Tchop</span>
            </div>

            {/* Discount */}
            <div className="bg-brand-light rounded-2xl py-4 mb-4">
              <p className="text-5xl font-black text-brand">{discountLabel}</p>
              <p className="text-sm text-ink-secondary mt-1">{t('voucher.discount')}</p>
            </div>

            {/* Code */}
            <p className="font-mono font-black text-2xl tracking-[0.2em] text-ink-primary mb-4">
              {voucher.code}
            </p>

            {/* QR code */}
            <div className="flex justify-center mb-4">
              <div className="bg-white p-3 rounded-2xl border-2 border-brand-light inline-block">
                <QRCodeSVG value={customerVoucherId} size={160} />
              </div>
            </div>

            {/* Details */}
            {voucher.min_order > 0 && (
              <p className="text-xs text-ink-tertiary mb-1">{t('voucher.minOrder')}: {Number(voucher.min_order).toLocaleString()} FCFA</p>
            )}
            <p className="text-xs text-ink-tertiary mb-4">
              {expiryStr ? `${t('voucher.expiry')} ${expiryStr}` : t('voucher.noExpiry')}
            </p>

            <p className="text-xs text-ink-secondary bg-brand-light rounded-xl px-3 py-2 mb-5">
              {t('voucher.present')}
            </p>

            <p className="text-xs text-ink-tertiary mb-4">{t('voucher.saveHint')}</p>

            <button
              onClick={() => setShowModal(false)}
              className="w-full bg-surface-muted hover:bg-divider text-ink-primary py-3 rounded-2xl font-semibold text-sm transition-colors"
            >
              {t('voucher.closeBtn')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
