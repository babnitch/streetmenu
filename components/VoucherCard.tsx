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
        isUsed ? 'border-gray-200 opacity-60' : isExpired ? 'border-red-100 opacity-70' : 'border-orange-100'
      }`}>
        {/* Left accent strip */}
        <div className={`absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl ${
          isActive ? 'bg-orange-500' : 'bg-gray-300'
        }`} />

        <div className="pl-5 pr-4 py-4 flex items-center gap-4">
          {/* Discount amount */}
          <div className={`flex-shrink-0 w-14 h-14 rounded-xl flex items-center justify-center font-black text-lg ${
            isActive ? 'bg-orange-50 text-orange-500' : 'bg-gray-50 text-gray-400'
          }`}>
            {discountLabel}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <p className={`font-mono font-bold text-base tracking-widest ${isActive ? 'text-gray-900' : 'text-gray-400'}`}>
              {voucher.code}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              {expiryStr ? `${t('voucher.expiry')} ${expiryStr}` : t('voucher.noExpiry')}
            </p>
          </div>

          {/* Status + QR button */}
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              isUsed ? 'bg-gray-100 text-gray-500' :
              isExpired ? 'bg-red-50 text-red-500' :
              'bg-green-50 text-green-600'
            }`}>
              {isUsed ? t('voucher.used') : isExpired ? t('voucher.expired') : t('voucher.active')}
            </span>
            {isActive && (
              <button
                onClick={() => setShowModal(true)}
                className="text-xs text-orange-500 hover:text-orange-600 font-semibold underline"
              >
                {t('voucher.viewBtn')}
              </button>
            )}
          </div>
        </div>

        {/* Dashed separator + QR preview */}
        {isActive && (
          <div className="border-t border-dashed border-orange-100 mx-4 mb-3 pt-3 flex items-center justify-between">
            <p className="text-xs text-gray-400">{t('voucher.present')}</p>
            <div className="bg-white p-1 rounded-lg border border-orange-100">
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
              <span className="bg-orange-500 text-white font-black text-sm px-2 py-1 rounded-lg tracking-tight">NT</span>
              <span className="font-bold text-gray-900">Ndjoka &amp; Tchop</span>
            </div>

            {/* Discount */}
            <div className="bg-orange-50 rounded-2xl py-4 mb-4">
              <p className="text-5xl font-black text-orange-500">{discountLabel}</p>
              <p className="text-sm text-gray-500 mt-1">{t('voucher.discount')}</p>
            </div>

            {/* Code */}
            <p className="font-mono font-black text-2xl tracking-[0.2em] text-gray-900 mb-4">
              {voucher.code}
            </p>

            {/* QR code */}
            <div className="flex justify-center mb-4">
              <div className="bg-white p-3 rounded-2xl border-2 border-orange-100 inline-block">
                <QRCodeSVG value={customerVoucherId} size={160} />
              </div>
            </div>

            {/* Details */}
            {voucher.min_order > 0 && (
              <p className="text-xs text-gray-400 mb-1">{t('voucher.minOrder')}: {Number(voucher.min_order).toLocaleString()} FCFA</p>
            )}
            <p className="text-xs text-gray-400 mb-4">
              {expiryStr ? `${t('voucher.expiry')} ${expiryStr}` : t('voucher.noExpiry')}
            </p>

            <p className="text-xs text-gray-500 bg-orange-50 rounded-xl px-3 py-2 mb-5">
              {t('voucher.present')}
            </p>

            <p className="text-xs text-gray-300 mb-4">{t('voucher.saveHint')}</p>

            <button
              onClick={() => setShowModal(false)}
              className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-2xl font-semibold text-sm transition-colors"
            >
              {t('voucher.closeBtn')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
