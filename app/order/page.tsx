'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useCart } from '@/lib/cartContext'
import { useLanguage } from '@/lib/languageContext'
import { supabase } from '@/lib/supabase'
import TopNav from '@/components/TopNav'
import { Voucher, CustomerVoucher } from '@/types'

// Customer session from the JWT cookie (what /account actually writes).
// The legacy useAuth hook reads Supabase Auth, which this app doesn't use
// for customers — so it always returns null here. Fetching /api/auth/me
// directly is the pattern already used by app/page.tsx and TopNav.
interface SessionUser { id: string; name: string; phone: string; role: string }

export default function OrderPage() {
  const { items, totalPrice, totalItems, restaurantId, updateQuantity, clearCart } = useCart()
  const router = useRouter()
  const { t } = useLanguage()

  const [me, setMe] = useState<SessionUser | null>(null)
  const [loadingMe, setLoadingMe] = useState(true)

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)

  const [voucherInput, setVoucherInput] = useState('')
  const [appliedVoucher, setAppliedVoucher] = useState<Voucher | null>(null)
  const [, setAppliedCvId] = useState<string | null>(null)
  const [voucherError, setVoucherError] = useState('')
  const [applyingVoucher, setApplyingVoucher] = useState(false)
  const [myVouchers, setMyVouchers] = useState<CustomerVoucher[]>([])

  // Pull session on mount; only treat role='customer' as "logged in" for the
  // purposes of this page (admins and vendors don't have customer-ordering
  // UX needs here).
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        if (data?.user?.role === 'customer') setMe(data.user)
      })
      .catch(() => null)
      .finally(() => { if (!cancelled) setLoadingMe(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!me) return
    supabase
      .from('customer_vouchers')
      .select('*, vouchers(*)')
      .eq('customer_id', me.id)
      .is('used_at', null)
      .then(({ data }) => {
        if (data) setMyVouchers(data.filter(cv => cv.vouchers?.is_active))
      })
  }, [me])

  const discountAmount = appliedVoucher
    ? appliedVoucher.discount_type === 'percent'
      ? Math.round(totalPrice * appliedVoucher.discount_value / 100)
      : Math.min(appliedVoucher.discount_value, totalPrice)
    : 0
  const finalPrice = totalPrice - discountAmount

  async function applyVoucher() {
    const code = voucherInput.trim().toUpperCase()
    if (!code || !restaurantId) return
    setApplyingVoucher(true)
    setVoucherError('')

    try {
      // Server-side validation — enforces scope, expiry, exhaustion,
      // per-customer limit, and min-order through the same library used
      // by the WhatsApp ordering flow.
      const res = await fetch('/api/customer/vouchers/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, restaurantId, orderTotal: totalPrice }),
      })
      const data = await res.json()
      if (!res.ok) {
        setVoucherError(data.error ?? 'Code invalide / Invalid code')
        return
      }
      // Only id/code/discount_type/discount_value are used for display
      // and for linking the voucher on the order row.
      setAppliedVoucher({
        id:             data.voucher.id,
        code:           data.voucher.code,
        discount_type:  data.voucher.discount_type,
        discount_value: data.voucher.discount_value,
        min_order:      0,
        max_uses:       null,
        uses_count:     0,
        expires_at:     null,
        is_active:      true,
        city:           null,
        created_at:     '',
      })
      setAppliedCvId(null)
    } finally {
      setApplyingVoucher(false)
    }
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

    // Logged-in customers use their session identity; guests use form input.
    // Source of truth matters: if the user edited the form then logged in
    // mid-flow, we still trust the session over stale form state.
    const customerName  = me?.name  ?? name.trim()
    const customerPhone = me?.phone ?? phone.trim()

    setSubmitting(true)
    const { data, error } = await supabase.from('orders').insert({
      restaurant_id: restaurantId,
      customer_name: customerName,
      customer_phone: customerPhone,
      items: items,
      total_price: finalPrice,
      status: 'pending',
      customer_id: me?.id ?? null,
      voucher_code: appliedVoucher?.code ?? null,
      discount_amount: discountAmount > 0 ? discountAmount : null,
    }).select().single()

    if (!error && data) {
      if (appliedVoucher) {
        // Server-side consumption: atomic current_uses bump + claim mark.
        fetch('/api/customer/vouchers/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voucherId: appliedVoucher.id, orderId: data.id }),
        }).catch(() => null)
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
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-5xl mb-4">🛒</div>
          <h2 className="text-xl font-bold text-ink-primary mb-2">{t('order.emptyTitle')}</h2>
          <p className="text-ink-secondary mb-6">{t('order.emptySub')}</p>
          <button
            onClick={() => router.push('/')}
            className="bg-brand text-white px-6 py-3 rounded-full font-semibold hover:bg-brand-dark transition-colors"
          >
            {t('order.exploreBtn')}
          </button>
        </div>
      </div>
    )
  }

  if (success) {
    // Confirmed-order phone: session value when logged in, form value otherwise.
    const confirmedPhone = me?.phone ?? phone
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-2xl font-bold text-ink-primary mb-2">{t('order.successTitle')}</h2>
          <p className="text-ink-secondary mb-2">{t('order.successSub')}</p>
          {orderId && (
            <p className="text-xs text-ink-tertiary mb-6 font-mono">
              Order #{orderId.slice(0, 8).toUpperCase()}
            </p>
          )}
          <div className="bg-surface rounded-2xl p-4 mb-6 shadow-card border border-divider text-left">
            <p className="text-sm text-ink-secondary">
              {t('order.contactPre')}{' '}
              <strong className="text-ink-primary">{confirmedPhone}</strong>{' '}
              {t('order.contactPost')}
            </p>
          </div>
          {me ? (
            <div className="space-y-2">
              <Link
                href="/account"
                className="block bg-brand hover:bg-brand-dark text-white px-6 py-3 rounded-full font-semibold transition-colors w-full"
              >
                📦 Voir mes commandes / View my orders
              </Link>
              <button
                onClick={() => router.push('/')}
                className="block text-ink-secondary text-sm py-2 w-full hover:text-ink-primary transition-colors"
              >
                {t('order.backToMap')}
              </button>
            </div>
          ) : (
            <button
              onClick={() => router.push('/')}
              className="bg-brand hover:bg-brand-dark text-white px-6 py-3 rounded-full font-semibold transition-colors w-full"
            >
              {t('order.backToMap')}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface-muted">
      <TopNav />
      {/* Sub-header */}
      <div className="bg-surface border-b border-divider px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="w-9 h-9 rounded-full bg-surface-muted flex items-center justify-center text-ink-secondary hover:bg-divider transition-colors"
          aria-label="Back"
        >
          ←
        </button>
        <h1 className="text-lg font-bold text-ink-primary">{t('order.title')}</h1>
        <span className="ml-auto text-sm text-ink-secondary">{totalItems} {t('order.items')}</span>
      </div>

      <div className="px-4 py-4 max-w-lg mx-auto pb-32">
        {/* Cart Items */}
        <div className="bg-surface rounded-2xl overflow-hidden shadow-card border border-divider mb-4">
          {items.map((item, idx) => (
            <div key={item.id} className={`flex items-center gap-3 px-4 py-3 ${idx < items.length - 1 ? 'border-b border-divider' : ''}`}>
              {item.photo_url ? (
                <div className="relative w-12 h-12 rounded-xl overflow-hidden flex-shrink-0">
                  <Image src={item.photo_url} alt={item.name} fill className="object-cover" sizes="48px" />
                </div>
              ) : (
                <div className="w-12 h-12 rounded-xl bg-brand-light flex items-center justify-center text-xl flex-shrink-0">🍽️</div>
              )}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-ink-primary text-sm truncate">{item.name}</p>
                <p className="text-brand-dark text-sm font-semibold">{item.price.toLocaleString()} FCFA</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => updateQuantity(item.id, item.quantity - 1)}
                  className="w-7 h-7 rounded-full bg-brand-light text-brand-darker font-bold flex items-center justify-center hover:bg-brand-badge transition-colors"
                  aria-label="Decrease"
                >
                  −
                </button>
                <span className="w-5 text-center text-sm font-semibold text-ink-primary">{item.quantity}</span>
                <button
                  onClick={() => updateQuantity(item.id, item.quantity + 1)}
                  className="w-7 h-7 rounded-full bg-brand-light text-brand-darker font-bold flex items-center justify-center hover:bg-brand-badge transition-colors"
                  aria-label="Increase"
                >
                  +
                </button>
              </div>
            </div>
          ))}
          <div className="px-4 py-2 flex items-center justify-between border-t border-divider">
            <span className="text-sm text-ink-secondary">{t('order.subtotal')}</span>
            <span className="text-sm font-semibold text-ink-primary">{totalPrice.toLocaleString()} FCFA</span>
          </div>
          {discountAmount > 0 && (
            <div className="px-4 py-2 flex items-center justify-between bg-brand-light">
              <span className="text-sm text-brand-darker">{t('order.discount')} ({appliedVoucher?.code})</span>
              <span className="text-sm font-bold text-brand-darker">−{discountAmount.toLocaleString()} FCFA</span>
            </div>
          )}
          <div className="px-4 py-3 bg-brand-light flex items-center justify-between">
            <span className="font-semibold text-ink-primary">{t('order.finalTotal')}</span>
            <span className="font-bold text-brand-dark text-lg">{finalPrice.toLocaleString()} FCFA</span>
          </div>
        </div>

        {/* Voucher section */}
        <div className="bg-surface rounded-2xl shadow-card border border-divider p-4 mb-4">
          <h3 className="text-sm font-bold text-ink-primary mb-3">🏷️ {t('order.voucherTitle')}</h3>
          {appliedVoucher ? (
            <div className="flex items-center justify-between bg-brand-light rounded-xl px-3 py-2.5">
              <div>
                <p className="text-sm font-bold text-brand-darker">{appliedVoucher.code}</p>
                <p className="text-xs text-brand-dark">{t('order.voucherApplied')} · −{discountAmount.toLocaleString()} FCFA</p>
              </div>
              <button onClick={removeVoucher} className="text-xs text-ink-tertiary hover:text-danger transition-colors ml-3">
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
                  className="flex-1 border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand uppercase bg-surface text-ink-primary"
                />
                <button
                  onClick={applyVoucher}
                  disabled={applyingVoucher || !voucherInput.trim()}
                  className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white px-4 py-2 rounded-full text-sm font-semibold transition-colors"
                >
                  {applyingVoucher ? t('order.applying') : t('order.applyBtn')}
                </button>
              </div>
              {voucherError && <p className="text-xs text-danger mt-1.5">{voucherError}</p>}
              {myVouchers.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-ink-tertiary mb-2">{t('order.myVouchers')}</p>
                  <div className="flex flex-wrap gap-2">
                    {myVouchers.map(cv => (
                      <button
                        key={cv.id}
                        onClick={() => setVoucherInput(cv.vouchers?.code ?? '')}
                        className="bg-brand-light text-brand-darker text-xs font-semibold px-2.5 py-1 rounded-full hover:bg-brand-badge transition-colors"
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

        {/* Customer identity — session if logged in, inputs otherwise */}
        <form onSubmit={handleSubmit}>
          <h2 className="text-base font-bold text-ink-primary mb-3">{t('order.detailsTitle')}</h2>

          {loadingMe ? (
            <div className="bg-surface rounded-2xl shadow-card border border-divider p-4 mb-4">
              <div className="skeleton h-4 w-40" />
            </div>
          ) : me ? (
            // Logged-in: read-only identity, no inputs
            <div className="bg-surface rounded-2xl shadow-card border border-divider overflow-hidden mb-4">
              <div className="px-4 py-3 bg-brand-light border-b border-divider">
                <p className="text-sm font-semibold text-ink-primary">👋 Bonjour {me.name}!</p>
                <p className="text-xs text-ink-secondary mt-0.5">
                  Hello {me.name}! <span className="text-ink-tertiary">— Ndjoka &amp; Tchop</span>
                </p>
              </div>
              <div className="px-4 py-3">
                <label className="block text-xs text-ink-tertiary mb-1">
                  {t('order.phoneLbl')} <span className="text-ink-tertiary">· non modifiable / not editable</span>
                </label>
                <p className="text-sm text-ink-primary font-mono">{me.phone}</p>
              </div>
            </div>
          ) : (
            // Guest: inputs + "log in to track" banner
            <>
              <div className="bg-surface rounded-2xl shadow-card border border-divider overflow-hidden mb-4">
                <div className="px-4 py-3 border-b border-divider">
                  <label className="block text-xs text-ink-secondary mb-1">{t('order.nameLbl')}</label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder={t('order.namePh')}
                    required
                    className="w-full text-sm text-ink-primary placeholder-ink-tertiary outline-none bg-transparent"
                  />
                </div>
                <div className="px-4 py-3">
                  <label className="block text-xs text-ink-secondary mb-1">{t('order.phoneLbl')}</label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder={t('order.phonePh')}
                    required
                    className="w-full text-sm text-ink-primary placeholder-ink-tertiary outline-none bg-transparent"
                  />
                </div>
              </div>
              <div className="bg-brand-light border border-brand-badge/50 rounded-2xl px-4 py-3 mb-4 flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-brand-darker flex-1 min-w-0">
                  Connectez-vous pour suivre vos commandes.<br />
                  <span className="text-brand-dark">Log in to track your orders.</span>
                </p>
                <Link
                  href="/account"
                  className="text-xs font-semibold bg-surface text-brand-darker px-3 py-1.5 rounded-full border border-brand-badge/60 hover:bg-brand-badge/20 transition-colors flex-shrink-0"
                >
                  Se connecter / Log in
                </Link>
              </div>
            </>
          )}

          <button
            type="submit"
            disabled={submitting || loadingMe || (!me && (!name || !phone))}
            className="w-full bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-4 rounded-full font-bold text-base shadow-card transition-colors"
          >
            {submitting ? t('order.placing') : `${t('order.placeBtn')} · ${finalPrice.toLocaleString()} FCFA`}
          </button>
        </form>
      </div>
    </div>
  )
}
