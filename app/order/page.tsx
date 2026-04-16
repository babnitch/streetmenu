'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { useCart } from '@/lib/cartContext'
import { useLanguage } from '@/lib/languageContext'
import { useAuth } from '@/lib/authContext'
import { supabase } from '@/lib/supabase'
import TopNav from '@/components/TopNav'
import { Voucher, CustomerVoucher } from '@/types'

export default function OrderPage() {
  const { items, totalPrice, totalItems, restaurantId, updateQuantity, clearCart } = useCart()
  const router = useRouter()
  const { t } = useLanguage()
  const { user } = useAuth()

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)

  const [voucherInput, setVoucherInput] = useState('')
  const [appliedVoucher, setAppliedVoucher] = useState<Voucher | null>(null)
  const [appliedCvId, setAppliedCvId] = useState<string | null>(null)
  const [voucherError, setVoucherError] = useState('')
  const [applyingVoucher, setApplyingVoucher] = useState(false)
  const [myVouchers, setMyVouchers] = useState<CustomerVoucher[]>([])

  useEffect(() => {
    if (!user) return
    supabase
      .from('customer_vouchers')
      .select('*, vouchers(*)')
      .eq('customer_id', user.id)
      .is('used_at', null)
      .then(({ data }) => {
        if (data) setMyVouchers(data.filter(cv => cv.vouchers?.is_active))
      })
  }, [user])

  const discountAmount = appliedVoucher
    ? appliedVoucher.discount_type === 'percent'
      ? Math.round(totalPrice * appliedVoucher.discount_value / 100)
      : Math.min(appliedVoucher.discount_value, totalPrice)
    : 0
  const finalPrice = totalPrice - discountAmount

  async function applyVoucher() {
    const code = voucherInput.trim().toUpperCase()
    if (!code) return
    setApplyingVoucher(true)
    setVoucherError('')

    const { data: voucher } = await supabase
      .from('vouchers')
      .select('*')
      .eq('code', code)
      .eq('is_active', true)
      .single()

    if (!voucher) {
      setVoucherError('Code invalide ou inactif.')
      setApplyingVoucher(false)
      return
    }
    if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
      setVoucherError('Ce bon a expiré.')
      setApplyingVoucher(false)
      return
    }
    if (totalPrice < voucher.min_order) {
      setVoucherError(`Commande minimum: ${voucher.min_order.toLocaleString()} FCFA.`)
      setApplyingVoucher(false)
      return
    }
    if (user) {
      const { data: cv } = await supabase
        .from('customer_vouchers')
        .select('*')
        .eq('customer_id', user.id)
        .eq('voucher_id', voucher.id)
        .not('used_at', 'is', null)
        .maybeSingle()
      if (cv) {
        setVoucherError('Vous avez déjà utilisé ce bon.')
        setApplyingVoucher(false)
        return
      }
      const { data: claimData } = await supabase
        .from('customer_vouchers')
        .select('id')
        .eq('customer_id', user.id)
        .eq('voucher_id', voucher.id)
        .is('used_at', null)
        .maybeSingle()
      setAppliedCvId(claimData?.id ?? null)
    }

    setAppliedVoucher(voucher)
    setApplyingVoucher(false)
  }

  function removeVoucher() {
    setAppliedVoucher(null)
    setAppliedCvId(null)
    setVoucherInput('')
    setVoucherError('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!restaurantId || items.length === 0) return

    setSubmitting(true)
    const { data, error } = await supabase.from('orders').insert({
      restaurant_id: restaurantId,
      customer_name: name.trim(),
      customer_phone: phone.trim(),
      items: items,
      total_price: finalPrice,
      status: 'pending',
      customer_id: user?.id ?? null,
      voucher_code: appliedVoucher?.code ?? null,
      discount_amount: discountAmount > 0 ? discountAmount : null,
    }).select().single()

    if (!error && data) {
      if (appliedVoucher) {
        await supabase.from('vouchers').update({ uses_count: (appliedVoucher.uses_count ?? 0) + 1 }).eq('id', appliedVoucher.id)
        if (appliedCvId) {
          await supabase.from('customer_vouchers').update({ used_at: new Date().toISOString() }).eq('id', appliedCvId)
        }
      }
      // Fire-and-forget WhatsApp notification to vendor
      fetch('/api/whatsapp/notify-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: data.id }),
      }).catch(() => null)
      setOrderId(data.id)
      setSuccess(true)
      clearCart()
    } else {
      alert(t('order.failed'))
    }
    setSubmitting(false)
  }

  if (items.length === 0 && !success) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-5xl mb-4">🛒</div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">{t('order.emptyTitle')}</h2>
          <p className="text-gray-500 mb-6">{t('order.emptySub')}</p>
          <button
            onClick={() => router.push('/')}
            className="bg-orange-500 text-white px-6 py-3 rounded-xl font-semibold hover:bg-orange-600 transition-colors"
          >
            {t('order.exploreBtn')}
          </button>
        </div>
      </div>
    )
  }

  if (success) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">{t('order.successTitle')}</h2>
          <p className="text-gray-500 mb-2">{t('order.successSub')}</p>
          {orderId && (
            <p className="text-xs text-gray-400 mb-6 font-mono">
              Order #{orderId.slice(0, 8).toUpperCase()}
            </p>
          )}
          <div className="bg-white rounded-2xl p-4 mb-6 shadow-sm text-left">
            <p className="text-sm text-gray-600">
              {t('order.contactPre')}{' '}
              <strong className="text-gray-900">{phone}</strong>{' '}
              {t('order.contactPost')}
            </p>
          </div>
          <button
            onClick={() => router.push('/')}
            className="bg-orange-500 text-white px-6 py-3 rounded-xl font-semibold hover:bg-orange-600 transition-colors w-full"
          >
            {t('order.backToMap')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-orange-50">
      <TopNav />
      {/* Sub-header */}
      <div className="bg-white shadow-sm px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="w-9 h-9 rounded-full bg-orange-50 flex items-center justify-center text-gray-600 hover:bg-orange-100 transition-colors"
        >
          ←
        </button>
        <h1 className="text-lg font-bold text-gray-900">{t('order.title')}</h1>
        <span className="ml-auto text-sm text-gray-500">{totalItems} {t('order.items')}</span>
      </div>

      <div className="px-4 py-4 max-w-lg mx-auto pb-32">
        {/* Cart Items */}
        <div className="bg-white rounded-2xl overflow-hidden shadow-sm mb-4">
          {items.map((item, idx) => (
            <div key={item.id} className={`flex items-center gap-3 px-4 py-3 ${idx < items.length - 1 ? 'border-b border-gray-50' : ''}`}>
              {item.photo_url ? (
                <div className="relative w-12 h-12 rounded-xl overflow-hidden flex-shrink-0">
                  <Image src={item.photo_url} alt={item.name} fill className="object-cover" />
                </div>
              ) : (
                <div className="w-12 h-12 rounded-xl bg-orange-50 flex items-center justify-center text-xl flex-shrink-0">🍽️</div>
              )}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 text-sm truncate">{item.name}</p>
                <p className="text-orange-500 text-sm font-semibold">{item.price.toLocaleString()} FCFA</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => updateQuantity(item.id, item.quantity - 1)}
                  className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 font-bold flex items-center justify-center hover:bg-orange-200 transition-colors"
                >
                  −
                </button>
                <span className="w-5 text-center text-sm font-semibold">{item.quantity}</span>
                <button
                  onClick={() => updateQuantity(item.id, item.quantity + 1)}
                  className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 font-bold flex items-center justify-center hover:bg-orange-200 transition-colors"
                >
                  +
                </button>
              </div>
            </div>
          ))}
          <div className="px-4 py-2 flex items-center justify-between border-t border-gray-50">
            <span className="text-sm text-gray-600">{t('order.subtotal')}</span>
            <span className="text-sm font-semibold text-gray-700">{totalPrice.toLocaleString()} FCFA</span>
          </div>
          {discountAmount > 0 && (
            <div className="px-4 py-2 flex items-center justify-between bg-green-50">
              <span className="text-sm text-green-700">{t('order.discount')} ({appliedVoucher?.code})</span>
              <span className="text-sm font-bold text-green-600">−{discountAmount.toLocaleString()} FCFA</span>
            </div>
          )}
          <div className="px-4 py-3 bg-orange-50 flex items-center justify-between">
            <span className="font-semibold text-gray-700">{t('order.finalTotal')}</span>
            <span className="font-bold text-orange-500 text-lg">{finalPrice.toLocaleString()} FCFA</span>
          </div>
        </div>

        {/* Voucher section */}
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
          <h3 className="text-sm font-bold text-gray-900 mb-3">🏷️ {t('order.voucherTitle')}</h3>
          {appliedVoucher ? (
            <div className="flex items-center justify-between bg-green-50 rounded-xl px-3 py-2.5">
              <div>
                <p className="text-sm font-bold text-green-700">{appliedVoucher.code}</p>
                <p className="text-xs text-green-600">{t('order.voucherApplied')} · -{discountAmount.toLocaleString()} FCFA</p>
              </div>
              <button onClick={removeVoucher} className="text-xs text-gray-400 hover:text-red-500 transition-colors ml-3">
                {t('order.removeVoucher')}
              </button>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={voucherInput}
                  onChange={e => setVoucherInput(e.target.value.toUpperCase())}
                  placeholder={t('order.voucherPh')}
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400 uppercase"
                />
                <button
                  onClick={applyVoucher}
                  disabled={applyingVoucher || !voucherInput.trim()}
                  className="bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
                >
                  {applyingVoucher ? t('order.applying') : t('order.applyBtn')}
                </button>
              </div>
              {voucherError && <p className="text-xs text-red-500 mt-1.5">{voucherError}</p>}
              {myVouchers.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-gray-400 mb-2">{t('order.myVouchers')}</p>
                  <div className="flex flex-wrap gap-2">
                    {myVouchers.map(cv => (
                      <button
                        key={cv.id}
                        onClick={() => setVoucherInput(cv.vouchers?.code ?? '')}
                        className="bg-orange-50 border border-orange-200 text-orange-600 text-xs font-semibold px-2.5 py-1 rounded-full hover:bg-orange-100 transition-colors"
                      >
                        {cv.vouchers?.code}
                        {cv.vouchers?.discount_type === 'percent'
                          ? ` −${cv.vouchers.discount_value}%`
                          : ` −${cv.vouchers?.discount_value?.toLocaleString()} FCFA`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Customer Form */}
        <form onSubmit={handleSubmit}>
          <h2 className="text-base font-bold text-gray-900 mb-3">{t('order.detailsTitle')}</h2>
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-4">
            <div className="px-4 py-3 border-b border-gray-50">
              <label className="block text-xs text-gray-500 mb-1">{t('order.nameLbl')}</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('order.namePh')}
                required
                className="w-full text-sm text-gray-900 placeholder-gray-400 outline-none"
              />
            </div>
            <div className="px-4 py-3">
              <label className="block text-xs text-gray-500 mb-1">{t('order.phoneLbl')}</label>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder={t('order.phonePh')}
                required
                className="w-full text-sm text-gray-900 placeholder-gray-400 outline-none"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || !name || !phone}
            className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-4 rounded-2xl font-bold text-base shadow-lg shadow-orange-200 transition-colors"
          >
            {submitting ? t('order.placing') : `${t('order.placeBtn')} · ${finalPrice.toLocaleString()} FCFA`}
          </button>
        </form>
      </div>
    </div>
  )
}
