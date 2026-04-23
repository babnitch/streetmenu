'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useCart } from '@/lib/cartContext'
import { useLanguage, useBi } from '@/lib/languageContext'
import { supabase } from '@/lib/supabase'
import TopNav from '@/components/TopNav'
import { Voucher, CustomerVoucher } from '@/types'

// Customer session from the JWT cookie (what /account actually writes).
// The legacy useAuth hook reads Supabase Auth, which this app doesn't use
// for customers — so it always returns null here. Fetching /api/auth/me
// directly is the pattern already used by app/page.tsx and TopNav.
interface SessionUser { id: string; name: string; phone: string; role: string }

// Local guess for which MNO label to show before the server confirms it.
// Mirrors lib/pawapay.ts detectMNO but keeps the lookup client-side so the
// order page can preview the wallet logo without a roundtrip.
function previewMNO(phone: string): { label: string; logo: string } | null {
  const digits = phone.replace(/[^\d+]/g, '')
  if (digits.startsWith('+237')) {
    const local = digits.slice(4)
    const p = local.slice(0, 2)
    if (['65', '67', '68'].includes(p)) return { label: 'MTN MoMo',     logo: '🟡' }
    if (p === '69')                     return { label: 'Orange Money', logo: '🟠' }
  }
  if (digits.startsWith('+225')) {
    const local = digits.slice(4)
    const p = local.slice(0, 2)
    if (['07', '08', '09'].includes(p)) return { label: 'MTN MoMo',     logo: '🟡' }
    if (['05', '06'].includes(p))       return { label: 'Orange Money', logo: '🟠' }
    if (p === '01')                     return { label: 'Moov Money',   logo: '🔵' }
  }
  if (digits.startsWith('+221')) {
    const local = digits.slice(4)
    const p = local.slice(0, 2)
    if (['77', '78'].includes(p)) return { label: 'Orange Money', logo: '🟠' }
    if (p === '76')               return { label: 'Free Money',   logo: '⚫' }
  }
  if (digits.startsWith('+229')) {
    const local = digits.slice(4)
    const p = local.slice(0, 2)
    if (['96', '97'].includes(p)) return { label: 'MTN MoMo',   logo: '🟡' }
    if (['94', '95'].includes(p)) return { label: 'Moov Money', logo: '🔵' }
  }
  return null
}

type PayPhase = 'idle' | 'waiting' | 'paid' | 'failed' | 'timeout'

export default function OrderPage() {
  const bi = useBi()
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

  // Payment flow state
  const [paymentEnabled, setPaymentEnabled] = useState(false)
  const [payPhase, setPayPhase] = useState<PayPhase>('idle')
  const [payError, setPayError] = useState('')
  const [activeDepositId, setActiveDepositId] = useState<string | null>(null)
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Resolve the restaurant's payment_enabled flag — anonymous reads work
  // because RLS already exposes restaurants for public browsing.
  useEffect(() => {
    if (!restaurantId) return
    let cancelled = false
    supabase
      .from('restaurants')
      .select('payment_enabled')
      .eq('id', restaurantId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setPaymentEnabled(Boolean(data?.payment_enabled))
      })
    return () => { cancelled = true }
  }, [restaurantId])

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

  // Cleanup on unmount — stale poll/timeout would keep firing after the
  // user navigates away and trigger setState-on-unmounted warnings.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  const discountAmount = appliedVoucher
    ? appliedVoucher.discount_type === 'percent'
      ? Math.round(totalPrice * appliedVoucher.discount_value / 100)
      : Math.min(appliedVoucher.discount_value, totalPrice)
    : 0
  const finalPrice = totalPrice - discountAmount

  const customerPhoneInput = me?.phone ?? phone
  const mnoPreview = customerPhoneInput ? previewMNO(customerPhoneInput) : null

  async function applyVoucher() {
    const code = voucherInput.trim().toUpperCase()
    if (!code || !restaurantId) return
    setApplyingVoucher(true)
    setVoucherError('')

    try {
      const res = await fetch('/api/customer/vouchers/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, restaurantId, orderTotal: totalPrice }),
      })
      const data = await res.json()
      if (!res.ok) {
        setVoucherError(data.error ?? bi('Code invalide', 'Invalid code'))
        return
      }
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

  // Inserts the order row. Returns the new order id, or null on failure.
  // Used by both the reservation and paid-order paths so cart/voucher
  // bookkeeping happens in one place.
  async function createOrderRow(orderType: 'reservation' | 'paid_order'): Promise<string | null> {
    if (!restaurantId || items.length === 0) return null

    const customerName  = me?.name  ?? name.trim()
    const customerPhone = me?.phone ?? phone.trim()

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
      order_type: orderType,
      payment_status: orderType === 'paid_order' ? 'pending' : 'not_required',
    }).select().single()

    if (error || !data) return null

    if (appliedVoucher) {
      fetch('/api/customer/vouchers/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voucherId: appliedVoucher.id, orderId: data.id }),
      }).catch(() => null)
    }

    return data.id
  }

  // Reservation path: insert row, fire vendor notification, jump to success.
  async function handleReservation(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    const id = await createOrderRow('reservation')
    if (id) {
      fetch('/api/whatsapp/notify-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: id }),
      }).catch(() => null)
      setOrderId(id)
      setSuccess(true)
      clearCart()
    } else {
      alert(t('order.failed'))
    }
    setSubmitting(false)
  }

  // Paid path: insert row first (so we have an orderId for PawaPay's
  // statementDescription), then call /api/payments/initiate, then poll.
  // The vendor WhatsApp ping is deferred until the webhook reports success —
  // a pending payment shouldn't wake up the kitchen.
  async function handlePay(e: React.FormEvent) {
    e.preventDefault()
    if (!customerPhoneInput) return
    setSubmitting(true)
    setPayError('')

    const id = pendingOrderId ?? await createOrderRow('paid_order')
    if (!id) {
      setSubmitting(false)
      alert(t('order.failed'))
      return
    }
    setPendingOrderId(id)

    const res = await fetch('/api/payments/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: id, phoneNumber: customerPhoneInput }),
    })
    const data = await res.json()
    if (!res.ok) {
      setPayError(data.error ?? bi('Erreur de paiement', 'Payment error'))
      setPayPhase('failed')
      setSubmitting(false)
      return
    }

    setActiveDepositId(data.depositId)
    setPayPhase('waiting')
    setSubmitting(false)
    startPolling(data.depositId, id)
  }

  function stopPolling() {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
  }

  function startPolling(depositId: string, orderRowId: string) {
    stopPolling()

    const tick = async () => {
      try {
        const r = await fetch(`/api/payments/status/${depositId}`, { cache: 'no-store' })
        const d = await r.json()
        if (d.phase === 'paid') {
          stopPolling()
          // Vendor + customer notifications fire from the webhook; trigger
          // the existing notify-order route too as a safety net (it sends
          // the order summary, separate from the paid receipt).
          fetch('/api/whatsapp/notify-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: orderRowId }),
          }).catch(() => null)
          setPayPhase('paid')
          setOrderId(orderRowId)
          setSuccess(true)
          clearCart()
        } else if (d.phase === 'failed') {
          stopPolling()
          setPayError(d.failureReason ?? bi('Paiement refusé', 'Payment refused'))
          setPayPhase('failed')
        }
      } catch {
        // Transient — keep polling. The 2-min timeout below is the failsafe.
      }
    }

    tick()
    pollTimerRef.current = setInterval(tick, 3000)
    timeoutRef.current = setTimeout(() => {
      stopPolling()
      setPayPhase(prev => prev === 'waiting' ? 'timeout' : prev)
    }, 120_000)
  }

  function retryPayment() {
    setPayError('')
    setPayPhase('idle')
    setActiveDepositId(null)
    // pendingOrderId stays — we re-use the same orders row on retry so we
    // don't accumulate ghost rows when the customer fumbles the prompt.
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
    const confirmedPhone = me?.phone ?? phone
    const wasPaid = payPhase === 'paid'
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-6xl mb-4">{wasPaid ? '✅' : '📋'}</div>
          <h2 className="text-2xl font-bold text-ink-primary mb-2">
            {wasPaid
              ? bi('Paiement confirmé!', 'Payment confirmed!')
              : bi('Commande réservée!', 'Order reserved!')}
          </h2>
          <p className="text-ink-secondary mb-2">
            {wasPaid
              ? bi('Votre commande a été payée et envoyée au restaurant.', 'Your order was paid and sent to the restaurant.')
              : bi('Le restaurant vous contactera pour confirmer.', 'The restaurant will contact you to confirm.')}
          </p>
          {orderId && (
            <p className="text-xs text-ink-tertiary mb-6 font-mono">
              Order #{orderId.slice(0, 8).toUpperCase()}
            </p>
          )}
          {!wasPaid && (
            <div className="bg-surface rounded-2xl p-4 mb-6 shadow-card border border-divider text-left">
              <p className="text-sm text-ink-secondary">
                {t('order.contactPre')}{' '}
                <strong className="text-ink-primary">{confirmedPhone}</strong>{' '}
                {t('order.contactPost')}
              </p>
            </div>
          )}
          {me ? (
            <div className="space-y-2">
              <Link
                href="/account"
                className="block bg-brand hover:bg-brand-dark text-white px-6 py-3 rounded-full font-semibold transition-colors w-full"
              >
                📦 {bi('Voir mes commandes', 'View my orders')}
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

  // Payment-waiting overlay — full-screen so the customer focuses on the
  // USSD prompt on their phone and can't accidentally re-trigger another
  // deposit while one is in flight.
  if (payPhase === 'waiting') {
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-6xl mb-6 animate-pulse">📱</div>
          <h2 className="text-xl font-bold text-ink-primary mb-3">
            {bi('En attente de confirmation…', 'Waiting for confirmation…')}
          </h2>
          <p className="text-sm text-ink-secondary mb-2">
            {bi('Validez le paiement sur votre téléphone.', 'Confirm the payment on your phone.')}
          </p>
          <p className="text-xs text-ink-tertiary mb-6 font-mono">
            {finalPrice.toLocaleString()} FCFA · {mnoPreview?.label ?? 'mobile money'}
          </p>
          <div className="flex justify-center mb-4">
            <div className="w-3 h-3 bg-brand rounded-full mx-1 animate-bounce" style={{ animationDelay: '0s' }} />
            <div className="w-3 h-3 bg-brand rounded-full mx-1 animate-bounce" style={{ animationDelay: '0.2s' }} />
            <div className="w-3 h-3 bg-brand rounded-full mx-1 animate-bounce" style={{ animationDelay: '0.4s' }} />
          </div>
          {activeDepositId && (
            <p className="text-[10px] text-ink-tertiary font-mono">ref: {activeDepositId.slice(0, 12)}…</p>
          )}
        </div>
      </div>
    )
  }

  if (payPhase === 'failed') {
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-6xl mb-4">❌</div>
          <h2 className="text-xl font-bold text-ink-primary mb-3">
            {bi('Paiement échoué.', 'Payment failed.')}
          </h2>
          {payError && <p className="text-sm text-danger mb-4">{payError}</p>}
          <p className="text-sm text-ink-secondary mb-6">
            {bi('Réessayez ou changez de méthode.', 'Try again or use a different method.')}
          </p>
          <button
            onClick={retryPayment}
            className="w-full bg-brand hover:bg-brand-dark text-white py-3 rounded-full font-bold transition-colors mb-2"
          >
            {bi('Réessayer / Retry', 'Retry / Réessayer')}
          </button>
          <button
            onClick={() => router.push('/')}
            className="text-ink-secondary text-sm py-2 hover:text-ink-primary transition-colors"
          >
            {t('order.backToMap')}
          </button>
        </div>
      </div>
    )
  }

  if (payPhase === 'timeout') {
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-6xl mb-4">⏱️</div>
          <h2 className="text-xl font-bold text-ink-primary mb-3">
            {bi('Paiement expiré.', 'Payment expired.')}
          </h2>
          <p className="text-sm text-ink-secondary mb-6">
            {bi("Vous n'avez pas confirmé à temps. Réessayez.", "You didn't confirm in time. Try again.")}
          </p>
          <button
            onClick={retryPayment}
            className="w-full bg-brand hover:bg-brand-dark text-white py-3 rounded-full font-bold transition-colors"
          >
            {bi('Réessayer / Retry', 'Retry / Réessayer')}
          </button>
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
        <form onSubmit={paymentEnabled ? handlePay : handleReservation}>
          <h2 className="text-base font-bold text-ink-primary mb-3">{t('order.detailsTitle')}</h2>

          {loadingMe ? (
            <div className="bg-surface rounded-2xl shadow-card border border-divider p-4 mb-4">
              <div className="skeleton h-4 w-40" />
            </div>
          ) : me ? (
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
                  {bi('Se connecter', 'Log in')}
                </Link>
              </div>
            </>
          )}

          {/* Payment section — only when restaurant accepts online payment.
              Shows the auto-detected MNO so the customer knows which wallet
              the deposit will hit before they tap Pay. */}
          {paymentEnabled && (
            <div className="bg-surface rounded-2xl shadow-card border border-divider p-4 mb-4">
              <p className="text-sm font-bold text-ink-primary mb-2">
                💳 {bi('Paiement mobile money', 'Mobile money payment')}
              </p>
              {mnoPreview ? (
                <div className="flex items-center gap-2 text-sm text-ink-secondary">
                  <span className="text-2xl">{mnoPreview.logo}</span>
                  <span>{mnoPreview.label}</span>
                </div>
              ) : (
                <p className="text-xs text-ink-tertiary">
                  {customerPhoneInput
                    ? bi('Numéro non reconnu pour le paiement mobile.', 'Phone not recognised for mobile payment.')
                    : bi('Saisissez votre numéro pour détecter votre opérateur.', 'Enter your phone to detect your operator.')}
                </p>
              )}
            </div>
          )}

          {!paymentEnabled && (
            <div className="bg-surface-muted border border-divider rounded-2xl px-4 py-3 mb-4">
              <p className="text-xs text-ink-secondary">
                📋 {bi(
                  'Ce restaurant accepte les réservations. Le paiement se fait sur place.',
                  'This restaurant accepts reservations. Payment happens on-site.',
                )}
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={
              submitting
              || loadingMe
              || (!me && (!name || !phone))
              || (paymentEnabled && !mnoPreview)
            }
            className={`w-full ${
              paymentEnabled
                ? 'bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300'
                : 'bg-brand hover:bg-brand-dark disabled:bg-brand-badge'
            } text-white py-4 rounded-full font-bold text-base shadow-card transition-colors`}
          >
            {submitting
              ? (paymentEnabled
                  ? bi('Initialisation du paiement…', 'Starting payment…')
                  : t('order.placing'))
              : paymentEnabled
                ? `${bi('Payer', 'Pay')} ${finalPrice.toLocaleString()} FCFA`
                : `📋 ${bi('Réserver la commande', 'Reserve order')} · ${finalPrice.toLocaleString()} FCFA`}
          </button>
        </form>
      </div>
    </div>
  )
}
