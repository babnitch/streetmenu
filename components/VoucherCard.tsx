'use client'

import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Voucher } from '@/types'
import { useLanguage, useBi } from '@/lib/languageContext'
import { isPercentDiscount } from '@/lib/vouchers'

interface VoucherCardProps {
  voucher: Voucher
  customerVoucherId: string
  usedAt?: string | null
}

// Uber Eats-style coupon. The card is a horizontal ticket with a dashed
// "tear line" between the discount panel (left) and the info panel
// (right). Available vouchers are full-colour with an orange accent;
// used / expired vouchers fade to grey + show a status pill. The full QR
// (for vendor-side scan validation) lives in a modal that opens on
// "View" so the compact list stays scannable.
export default function VoucherCard({ voucher, customerVoucherId, usedAt }: VoucherCardProps) {
  const { t } = useLanguage()
  const bi = useBi()
  const [showModal, setShowModal] = useState(false)

  const isUsed = !!usedAt
  const isExpired = voucher.expires_at ? new Date(voucher.expires_at) < new Date() : false
  const isActive = !isUsed && !isExpired && voucher.is_active

  const discountLabel = isPercentDiscount(voucher.discount_type)
    ? `${voucher.discount_value}%`
    : `${Number(voucher.discount_value).toLocaleString()}F`

  const expiryStr = voucher.expires_at
    ? new Date(voucher.expires_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
    : null

  const restaurantName = voucher.restaurants?.name ?? null
  const scopeLabel = restaurantName
    ? `🏪 ${restaurantName}`
    : bi('🌍 Tous les restaurants', '🌍 All restaurants')

  // Background of the left "discount panel". Active → brand orange.
  // Used/expired → muted neutral. Border colour matches the panel so the
  // dashed separator reads as a true tear line rather than an outline.
  const panelBg     = isActive ? 'bg-brand text-white'           : 'bg-surface-muted text-ink-tertiary'
  const cardBorder  = isActive ? 'border-brand-light'            : 'border-divider'
  const codeColor   = isActive ? 'text-ink-primary'              : 'text-ink-tertiary'
  const opacityCls  = !isActive ? 'opacity-70'                   : ''

  return (
    <>
      <div className={`relative bg-white rounded-2xl shadow-sm border overflow-hidden flex ${cardBorder} ${opacityCls}`}>
        {/* Discount panel — Uber Eats puts the big value here, on a coloured
            block so the eye lands on it immediately. */}
        <div className={`flex-shrink-0 w-24 flex flex-col items-center justify-center px-2 py-4 ${panelBg}`}>
          <p className="text-2xl font-black leading-none">{discountLabel}</p>
          <p className="text-[10px] font-semibold uppercase tracking-wider mt-1 opacity-90">
            {isPercentDiscount(voucher.discount_type) ? bi('Réduction', 'Off') : 'FCFA'}
          </p>
        </div>

        {/* Tear line — the dashed coupon separator. Two stacked elements:
            a vertical dashed border in the brand colour, and small
            half-circle "punches" at top and bottom to sell the ticket
            metaphor. */}
        <div className="relative w-0 self-stretch">
          <div className={`absolute inset-y-0 left-0 border-l-2 border-dashed ${isActive ? 'border-brand-light' : 'border-divider'}`} />
          <span className="absolute -top-2 -left-2 w-4 h-4 rounded-full bg-surface" aria-hidden />
          <span className="absolute -bottom-2 -left-2 w-4 h-4 rounded-full bg-surface" aria-hidden />
        </div>

        {/* Info panel */}
        <div className="flex-1 min-w-0 px-4 py-3 flex flex-col justify-between">
          <div className="min-w-0">
            <p className={`font-mono font-bold text-base tracking-[0.15em] truncate ${codeColor}`}>
              {voucher.code}
            </p>
            <p className="text-[11px] text-ink-tertiary mt-0.5 truncate">{scopeLabel}</p>
            <p className="text-[11px] text-ink-tertiary mt-0.5">
              {expiryStr ? `${t('voucher.expiry')} ${expiryStr}` : t('voucher.noExpiry')}
            </p>
            {voucher.min_order > 0 && (
              <p className="text-[11px] text-ink-tertiary mt-0.5">
                {bi('Min:', 'Min:')} {Number(voucher.min_order).toLocaleString()} FCFA
              </p>
            )}
          </div>

          <div className="flex items-center justify-between mt-2">
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
              isUsed
                ? 'bg-surface-muted text-ink-secondary'
                : isExpired
                  ? 'bg-rose-50 text-rose-700 border border-rose-200'
                  : 'bg-brand-light text-brand-darker'
            }`}>
              {isUsed ? `✅ ${t('voucher.used')}` : isExpired ? `⏰ ${t('voucher.expired')}` : `🟢 ${t('voucher.active')}`}
            </span>
            {isActive && (
              <button
                onClick={() => setShowModal(true)}
                className="text-[11px] text-brand hover:text-brand-dark font-semibold underline"
              >
                {t('voucher.viewBtn')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Full-screen modal — unchanged from the previous design; vendors
          scan the QR to validate the claim. */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setShowModal(false)}>
          <div
            className="bg-white rounded-3xl p-6 w-full max-w-sm text-center shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-center gap-2 mb-5">
              <span className="bg-brand text-white font-black text-sm px-2 py-1 rounded-lg tracking-tight">NT</span>
              <span className="font-bold text-ink-primary">Ndjoka &amp; Tchop</span>
            </div>

            <div className="bg-brand text-white rounded-2xl py-4 mb-4">
              <p className="text-5xl font-black">
                {isPercentDiscount(voucher.discount_type) ? `-${voucher.discount_value}%` : `-${Number(voucher.discount_value).toLocaleString()} FCFA`}
              </p>
              <p className="text-sm opacity-90 mt-1">{t('voucher.discount')}</p>
            </div>

            <p className="font-mono font-black text-2xl tracking-[0.2em] text-ink-primary mb-2">
              {voucher.code}
            </p>
            <p className="text-xs text-ink-secondary mb-4">{scopeLabel}</p>

            <div className="flex justify-center mb-4">
              <div className="bg-white p-3 rounded-2xl border-2 border-brand-light inline-block">
                <QRCodeSVG value={customerVoucherId} size={160} />
              </div>
            </div>

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
