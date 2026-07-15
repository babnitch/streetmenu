'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useRef } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Event } from '@/types'
import { useLanguage, useBi, pickBi } from '@/lib/languageContext'
import { categoryLabel } from '@/lib/categoryLabels'
import TopNav from '@/components/TopNav'
import EventSocialPanel from '@/components/EventSocialPanel'
import ReportButton from '@/components/ReportButton'
import PhoneInput from '@/components/PhoneInput'
import { getCountryFromCity } from '@/lib/phoneValidation'
import { normalizeMode, modeFromLegacy, effectiveWebMode, canPayOnline, canReserve } from '@/lib/paymentMode'

// Mirror of the MNO prefix check in /order — only the four PawaPay-routed
// dial codes (CMR/CIV/SEN/BEN) are accepted, with or without the leading '+'.
const SUPPORTED_COUNTRY_CODES = ['237', '225', '221', '229'] as const
function hasSupportedCountryPrefix(phone: string): boolean {
  const digits = phone.replace(/[^\d]/g, '')
  return SUPPORTED_COUNTRY_CODES.some(p => digits.startsWith(p))
}
type PayPhase = 'idle' | 'waiting' | 'paid' | 'failed' | 'timeout'

// Customer session — pulled lazily so guests still get the page. Mirrors
// the pattern in /order: /api/auth/me drives the prefill, no Supabase Auth.
interface SessionUser { id: string; name: string; phone: string; role: string }

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { t, locale } = useLanguage()
  const bi = useBi()
  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState<SessionUser | null>(null)

  // Tier picker. Empty when the event has no tiers (backward-compat
  // single-price path stays untouched). Per-tier quantity is tracked in
  // `tierQty` keyed by tier id; missing keys default to 0.
  interface PublicTier {
    id: string
    name: string
    name_en: string | null
    price: number
    max_quantity: number
    sold_count: number
    sales_start: string | null
    sales_end: string | null
    description: string | null
  }
  const [tiers, setTiers] = useState<PublicTier[]>([])
  const [tierQty, setTierQty] = useState<Record<string, number>>({})

  // Reservation modal state
  const [showModal, setShowModal] = useState(false)
  const [quantity, setQuantity] = useState(1)
  const [guestName, setGuestName] = useState('')
  const [guestPhone, setGuestPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [reserveError, setReserveError] = useState('')
  const [reservationId, setReservationId] = useState<string | null>(null)
  const [reservationCode, setReservationCode] = useState<string | null>(null)
  // Promo code state — collapsible section above the Reserve/Pay button.
  const [promoOpen, setPromoOpen] = useState(false)
  const [promoInput, setPromoInput] = useState('')
  const [promoChecking, setPromoChecking] = useState(false)
  const [promoError, setPromoError] = useState('')
  const [appliedPromo, setAppliedPromo] = useState<{ code: string; discount: number } | null>(null)
  // Which path the open modal is running: true = pay online, false = reserve.
  // Set when the customer taps the Pay vs Reserve button (mode 'both' offers
  // both); replaces the old event.payment_enabled branch inside the modal.
  const [payNow, setPayNow] = useState(false)

  // Paid-flow state (mirrors /order).
  const [momoPhone, setMomoPhone] = useState('')
  const [payPhase, setPayPhase] = useState<PayPhase>('idle')
  const [activeDepositId, setActiveDepositId] = useState<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup pollers on unmount so a stale tick can't setState on a dead
  // component after the user navigates away mid-USSD.
  useEffect(() => () => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  useEffect(() => {
    async function fetchEvent() {
      const { data } = await supabase.from('events').select('*').eq('id', id).single()
      setEvent(data)
      setLoading(false)
      // Tiers are fetched separately so the event card renders without
      // waiting for them — empty list is a valid public state.
      try {
        const tRes = await fetch(`/api/events/${id}/tiers`, { cache: 'no-store' })
        const tJson = await tRes.json()
        if (Array.isArray(tJson?.tiers)) setTiers(tJson.tiers)
      } catch { /* silent — single-price flow */ }
    }
    fetchEvent()
  }, [id])

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => { if (data?.user?.role === 'customer') setMe(data.user) })
      .catch(() => null)
  }, [])

  if (loading) {
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen flex items-center justify-center bg-surface">
        <div className="text-4xl animate-bounce">🎉</div>
      </div>
    )
  }

  if (!event) {
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen flex flex-col items-center justify-center gap-4 bg-surface">
        <div className="text-5xl">😕</div>
        <p className="text-ink-secondary">{t('evt.notFound')}</p>
        <Link href="/events" className="text-brand underline text-sm">{t('evt.back')}</Link>
      </div>
    )
  }

  const dateStr = new Date(event.date).toLocaleDateString('fr-FR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  })

  // Reservation gating + price display all derive from a single source of
  // truth so the button copy and the modal stay in lockstep.
  const hasTiers     = tiers.length > 0
  const ticketPrice  = Number(event.ticket_price ?? event.price ?? 0) || 0
  const isFree       = hasTiers
    ? tiers.every(t => t.price === 0)
    : ticketPrice === 0
  const maxTickets   = Number(event.max_tickets ?? 0)
  const ticketsSold  = Number(event.tickets_sold ?? 0)
  const remaining    = maxTickets > 0 ? Math.max(0, maxTickets - ticketsSold) : Infinity
  const soldOut      = maxTickets > 0 && remaining <= 0
  const isCancelled  = event.event_status === 'cancelled'
  const isCompleted  = event.event_status === 'completed'
  // Organizer can close the reservation gate independently of event_status —
  // e.g. soft-pause to manage walk-ins. Default is open (column default).
  const reservationsClosed = event.reservations_open === false
  const reservable   = !isCancelled && !isCompleted && !soldOut && !reservationsClosed
  // Resolve the 3-way payment mode (free events collapse to reservation_only).
  // reservation_only / both → reserve button; payment_only / both → pay button.
  // For 'both', both buttons render and the customer chooses.
  const paymentMode  = effectiveWebMode(
    normalizeMode(event.payment_mode ?? modeFromLegacy(event.payment_enabled)),
    isFree,
  )
  const onlineReservable    = reservable && canReserve(paymentMode)
  const onlinePayReservable = reservable && canPayOnline(paymentMode) && ticketPrice > 0

  // Tier-mode totals — sum of (price × qty) across every tier with a
  // positive quantity in tierQty.
  const tierTotalQty = hasTiers
    ? tiers.reduce((s, t) => s + (tierQty[t.id] ?? 0), 0)
    : 0
  const tierTotalPrice = hasTiers
    ? tiers.reduce((s, t) => s + (tierQty[t.id] ?? 0) * t.price, 0)
    : 0
  const selectedTierItems = hasTiers
    ? tiers
        .map(t => ({ tier_id: t.id, quantity: tierQty[t.id] ?? 0, price: t.price }))
        .filter(i => i.quantity > 0)
    : []
  const totalForQty = hasTiers ? tierTotalPrice : ticketPrice * quantity
  // Applied-promo discount, capped at the current total (guards against a
  // stale fixed discount exceeding a smaller quantity). finalTotal is the
  // amount actually charged / shown on the button.
  const promoDiscount = appliedPromo ? Math.min(appliedPromo.discount, totalForQty) : 0
  const finalTotal    = Math.max(0, totalForQty - promoDiscount)

  // Validate a promo code against this event for the current total. Preview
  // only — the reserve/pay route re-validates and consumes at booking time.
  async function applyPromo() {
    const code = promoInput.trim()
    if (!code || promoChecking) return
    setPromoChecking(true)
    setPromoError('')
    try {
      const res = await fetch(`/api/events/${event!.id}/vouchers/validate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code, orderTotal: totalForQty }),
      })
      const d = await res.json()
      if (!d.ok) {
        setAppliedPromo(null)
        setPromoError(pickBi(d.message ?? 'Code invalide / Invalid code', locale))
        return
      }
      setAppliedPromo({ code: d.voucher.code, discount: d.discount })
      setPromoError('')
    } catch {
      setPromoError(bi('Erreur, réessayez.', 'Error, try again.'))
    } finally {
      setPromoChecking(false)
    }
  }
  function clearPromo() {
    setAppliedPromo(null)
    setPromoInput('')
    setPromoError('')
  }

  const trimmedMomo  = momoPhone.trim()
  const momoValid    = trimmedMomo ? hasSupportedCountryPrefix(trimmedMomo) : false

  const whatsappMsg = encodeURIComponent(
    `Bonjour ! Je suis intéressé(e) par votre événement "${event.title}" le ${dateStr}.`
  )
  const whatsappNumber = event.whatsapp?.replace(/[^0-9]/g, '')
  const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${whatsappMsg}`

  const shareMsg = encodeURIComponent(
    `🎉 ${event.title} — ${dateStr}${event.venue ? ` @ ${event.venue}` : ''}\nvia Tchop & Ndjoka`
  )
  const shareUrl = `https://wa.me/?text=${shareMsg}`

  function openReserve(pay: boolean) {
    setPayNow(pay)
    setQuantity(1)
    setReserveError('')
    setReservationId(null)
    setReservationCode(null)
    setPromoOpen(false)
    setPromoInput('')
    setPromoError('')
    setAppliedPromo(null)
    setGuestName('')
    setGuestPhone('')
    setMomoPhone('')
    setPayPhase('idle')
    setActiveDepositId(null)
    setShowModal(true)
  }

  function stopPolling() {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
    if (timeoutRef.current)   { clearTimeout(timeoutRef.current);    timeoutRef.current = null }
  }

  function startPolling(depositId: string) {
    stopPolling()
    const tick = async () => {
      try {
        const r = await fetch(`/api/payments/status/${depositId}`, { cache: 'no-store' })
        const d = await r.json()
        if (d.phase === 'paid') {
          stopPolling()
          setPayPhase('paid')
          const { data: refreshed } = await supabase.from('events').select('*').eq('id', event!.id).single()
          if (refreshed) setEvent(refreshed)
        } else if (d.phase === 'failed') {
          stopPolling()
          setReserveError(d.failureReason ?? bi('Paiement refusé', 'Payment refused'))
          setPayPhase('failed')
        }
      } catch { /* transient — keep polling, 2-min timeout below is the failsafe */ }
    }
    tick()
    pollTimerRef.current = setInterval(tick, 3000)
    timeoutRef.current   = setTimeout(() => {
      stopPolling()
      setPayPhase(prev => prev === 'waiting' ? 'timeout' : prev)
    }, 120_000)
  }

  async function submitPay() {
    if (!trimmedMomo || !momoValid) return
    setSubmitting(true)
    setReserveError('')
    try {
      // Paid checkout buys one tier per PawaPay deposit. If the user
      // selected multiple tiers in the picker, we send the first one
      // with positive qty — the modal copy below the picker spells
      // this out, so the failure case is "fine, but suboptimal" not
      // "lost money".
      const tierItem = selectedTierItems[0]
      const body: Record<string, unknown> = {
        quantity:    hasTiers ? (tierItem?.quantity ?? 1) : quantity,
        phoneNumber: trimmedMomo,
      }
      if (hasTiers && tierItem) body.tier_id = tierItem.tier_id
      if (appliedPromo) body.voucher_code = appliedPromo.code
      if (!me) {
        body.customer_name  = guestName.trim()
        body.customer_phone = guestPhone.trim()
      }
      const res = await fetch(`/api/events/${event!.id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setReserveError(data.error ?? bi('Erreur de paiement', 'Payment error'))
        setPayPhase('failed')
        return
      }
      setReservationId(data.reservation_id)
      setReservationCode(data.reservation_code ?? null)
      setActiveDepositId(data.depositId)
      setPayPhase('waiting')
      startPolling(data.depositId)
    } finally {
      setSubmitting(false)
    }
  }

  async function submitReserve() {
    setSubmitting(true)
    setReserveError('')
    try {
      // Tier mode sends items[]; legacy single-price sends quantity.
      // The API accepts both shapes — see app/api/events/[id]/reserve.
      const body: Record<string, unknown> = hasTiers
        ? { items: selectedTierItems.map(i => ({ tier_id: i.tier_id, quantity: i.quantity })) }
        : { quantity }
      if (appliedPromo) body.voucher_code = appliedPromo.code
      if (!me) {
        body.customer_name  = guestName.trim()
        body.customer_phone = guestPhone.trim()
      }
      const res = await fetch(`/api/events/${event!.id}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setReserveError(data.error ?? bi('Erreur de réservation', 'Reservation error'))
        return
      }
      setReservationId(data.reservation_id)
      setReservationCode(data.reservation_code ?? null)
      // Re-fetch event so the remaining counter reflects the new sale.
      const { data: refreshed } = await supabase.from('events').select('*').eq('id', event!.id).single()
      if (refreshed) setEvent(refreshed)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />

      {/* Hero */}
      <div className="relative h-56 sm:h-72 bg-gradient-to-br from-brand-badge to-brand">
        {event.cover_photo && (
          <Image src={event.cover_photo} alt={event.title} fill className="object-cover" priority />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

        <div className="absolute top-4 left-4 z-10">
          <Link
            href="/events"
            className="bg-white/90 backdrop-blur-sm text-ink-primary px-3 py-1.5 rounded-xl text-sm font-semibold flex items-center gap-1 hover:bg-white transition-colors"
          >
            {t('evt.back')}
          </Link>
        </div>

        <div className="absolute bottom-4 left-4 right-4 z-10">
          <span className="inline-block bg-brand text-white text-xs font-bold px-2.5 py-1 rounded-full mb-2">
            {categoryLabel(event.category, locale)}
          </span>
          <h1 className="text-white text-2xl font-bold leading-tight drop-shadow-lg">
            {event.title}
          </h1>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-xl mx-auto px-4 py-6 space-y-6">
        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3">
          <DetailRow icon="📅" label={t('evt.date')} value={`${dateStr}${event.time ? ` · ${event.time}` : ''}`} />
          {event.venue && (
            <DetailRow
              icon="📍"
              label={t('evt.venue')}
              value={`${event.venue}${event.neighborhood ? `, ${event.neighborhood}` : ''}${event.city ? ` — ${event.city}` : ''}`}
            />
          )}
          <DetailRow
            icon="🎟"
            label={t('evt.price')}
            value={
              isFree
                ? t('evt.free')
                : `${ticketPrice.toLocaleString()} FCFA${bi(' / personne', ' / person')}`
            }
          />
          {maxTickets > 0 && !soldOut && (
            <DetailRow
              icon="👥"
              label={bi('Disponibilité', 'Availability')}
              value={`${remaining} ${bi('places restantes', 'spots remaining')}`}
            />
          )}
          {event.organizer_name && (
            <DetailRow icon="👤" label={t('evt.organizer')} value={event.organizer_name} />
          )}
        </div>

        {event.description && (
          <div className="bg-white rounded-2xl p-4 shadow-sm">
            <p className="text-ink-primary text-sm leading-relaxed whitespace-pre-wrap">{event.description}</p>
          </div>
        )}

        {/* Status banners — replaces the Reserve button when the event
            can't accept new reservations. */}
        {isCancelled && (
          <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 text-center text-sm font-semibold text-rose-700">
            {bi('❌ Événement annulé', '❌ Event cancelled')}
          </div>
        )}
        {!isCancelled && isCompleted && (
          <div className="bg-surface-muted border border-divider rounded-2xl p-4 text-center text-sm font-semibold text-ink-secondary">
            {bi('🏁 Événement terminé', '🏁 Event ended')}
          </div>
        )}
        {!isCancelled && !isCompleted && soldOut && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center text-sm font-semibold text-amber-700">
            {bi('🎟 Complet', '🎟 Sold out')}
          </div>
        )}
        {!isCancelled && !isCompleted && !soldOut && reservationsClosed && (
          <div className="bg-surface-muted border border-divider rounded-2xl p-4 text-center text-sm font-semibold text-ink-secondary">
            🔒 {bi('Les réservations sont fermées.', 'Reservations are closed.')}
          </div>
        )}

        {/* Tier picker — only when the event has tiers AND we can still
            sell. Per-tier qty stepper, total at the bottom, modal opens
            once at least one tier is selected. */}
        {hasTiers && reservable && (
          <div className="space-y-2">
            {tiers.map(t => {
              const displayName = locale === 'en' && t.name_en ? t.name_en : t.name
              const remaining = t.max_quantity > 0 ? Math.max(0, t.max_quantity - t.sold_count) : null
              const tierSoldOut = remaining === 0
              const qty = tierQty[t.id] ?? 0
              const canInc = !tierSoldOut && (remaining === null || qty < remaining) && qty < 10
              return (
                <div key={t.id} className={`bg-white rounded-2xl shadow-sm border ${tierSoldOut ? 'border-divider opacity-60' : 'border-brand-light'} p-3`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink-primary text-sm">🎫 {displayName}</p>
                      {t.description && (
                        <p className="text-xs text-ink-tertiary mt-0.5">{t.description}</p>
                      )}
                      <p className="text-xs text-ink-tertiary mt-1">
                        {tierSoldOut
                          ? bi('🔴 Épuisé', '🔴 Sold out')
                          : remaining !== null
                            ? `👥 ${remaining}/${t.max_quantity} ${bi('restants', 'left')}`
                            : `👥 ${bi('Places disponibles', 'Available')}`}
                      </p>
                    </div>
                    <p className="text-sm font-bold text-brand-darker flex-shrink-0">
                      {t.price === 0 ? bi('Gratuit', 'Free') : `${t.price.toLocaleString()} FCFA`}
                    </p>
                  </div>
                  {!tierSoldOut && (
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <button
                        type="button"
                        onClick={() => setTierQty(prev => ({ ...prev, [t.id]: Math.max(0, (prev[t.id] ?? 0) - 1) }))}
                        disabled={qty === 0}
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-surface-muted text-ink-primary text-sm font-bold disabled:opacity-50"
                      >
                        −
                      </button>
                      <span className="w-6 text-center text-sm font-semibold tabular-nums">{qty}</span>
                      <button
                        type="button"
                        onClick={() => setTierQty(prev => ({ ...prev, [t.id]: (prev[t.id] ?? 0) + 1 }))}
                        disabled={!canInc}
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-brand-light text-brand-darker text-sm font-bold disabled:opacity-50"
                      >
                        +
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Reserve button — only for events the in-app flow can handle. */}
        {onlineReservable && (
          <button
            onClick={() => openReserve(false)}
            disabled={hasTiers && tierTotalQty === 0}
            className="block w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white text-center py-3.5 rounded-2xl text-sm font-bold transition-colors shadow-card"
          >
            {hasTiers ? (
              tierTotalQty === 0
                ? bi('Sélectionnez un tarif', 'Pick a tier')
                : tierTotalPrice === 0
                  ? bi('📋 Réserver gratuitement', '📋 Reserve free')
                  : `📋 ${bi('Réserver', 'Reserve')} ${tierTotalPrice.toLocaleString()} FCFA`
            ) : (
              <>
                📋 {bi('Réserver', 'Reserve')}
                {!isFree && (
                  <span className="block text-xs font-normal opacity-90 mt-0.5">
                    {bi('Paiement sur place', 'Pay at the door')} · {ticketPrice.toLocaleString()} FCFA{bi(' / personne', ' / person')}
                  </span>
                )}
              </>
            )}
          </button>
        )}

        {/* Paid online reservation — PawaPay flow. Multi-tier paid
            checkouts buy one tier per deposit, so the button label
            picks the highest-qty selected tier. */}
        {onlinePayReservable && (
          <button
            onClick={() => openReserve(true)}
            disabled={hasTiers && tierTotalQty === 0}
            className="block w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-center py-3.5 rounded-2xl text-sm font-bold transition-colors shadow-card"
          >
            💰 {bi('Réserver et payer', 'Reserve and pay')}
            <span className="block text-xs font-normal opacity-90 mt-0.5">
              {hasTiers
                ? (tierTotalPrice > 0 ? `${tierTotalPrice.toLocaleString()} FCFA` : bi('Sélectionnez un tarif', 'Pick a tier'))
                : `${ticketPrice.toLocaleString()} FCFA${bi(' / personne', ' / person')}`}
            </span>
          </button>
        )}

        {whatsappNumber && (
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full bg-white border border-divider hover:bg-surface-muted text-ink-primary text-center py-3 rounded-2xl text-sm font-semibold transition-colors"
          >
            💬 {t('evt.interested')}
          </a>
        )}

        <a
          href={shareUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full bg-white border border-divider hover:bg-surface-muted text-ink-primary text-center py-3 rounded-2xl text-sm font-semibold transition-colors"
        >
          {t('evt.share')}
        </a>

        {/* Likes + comments. Self-contained component — owns its own auth
            read and API roundtrips. Comments are nickname-signed; the
            nickname prompt fires inline on first comment. */}
        <EventSocialPanel eventId={event.id} />

        <ReportButton
          targetType="event"
          targetId={event.id}
          label={bi('Signaler cet événement', 'Report this event')}
        />
      </div>

      {/* Reserve modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => !submitting && setShowModal(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal body branches: success → waiting → failed/timeout → form.
                Free flow short-circuits to success the moment reservationId
                lands; paid flow holds at 'waiting' until the poller flips
                payPhase to 'paid' (or 'failed' / 'timeout'). */}
            {((reservationId && !payNow) || payPhase === 'paid') ? (
              <div className="text-center">
                <div className="text-5xl mb-3">{payPhase === 'paid' ? '🎟' : '✅'}</div>
                <h3 className="font-bold text-ink-primary text-lg mb-1">
                  {payPhase === 'paid'
                    ? bi('Paiement confirmé!', 'Payment confirmed!')
                    : bi('Réservation confirmée!', 'Reservation confirmed!')}
                </h3>
                <p className="text-sm text-ink-secondary mb-4">
                  {bi('Un message WhatsApp vient de partir.', 'A WhatsApp message just went out.')}
                </p>
                {reservationCode && (
                  <div className="mb-4 rounded-2xl bg-brand-light border border-brand-badge px-4 py-3">
                    <p className="text-xs text-brand-darker font-semibold">
                      {bi('Votre code de réservation', 'Your reservation code')}
                    </p>
                    <p className="text-2xl font-bold font-mono tracking-widest text-ink-primary mt-0.5">
                      #{reservationCode}
                    </p>
                    <p className="text-[11px] text-ink-tertiary mt-1">
                      {bi('Présentez ce code à l\'entrée.', 'Show this code at the entrance.')}
                    </p>
                  </div>
                )}
                <Link
                  href="/account?tab=orders"
                  className="block w-full bg-brand hover:bg-brand-dark text-white py-2.5 rounded-full text-sm font-semibold transition-colors"
                >
                  📦 {bi('Voir mes réservations', 'View my reservations')}
                </Link>
                <button
                  onClick={() => setShowModal(false)}
                  className="block w-full text-ink-secondary text-xs py-2 mt-2 hover:text-ink-primary"
                >
                  {bi('Fermer', 'Close')}
                </button>
              </div>
            ) : payPhase === 'waiting' ? (
              <div className="text-center py-4">
                <div className="text-5xl mb-4 animate-pulse">📱</div>
                <h3 className="font-bold text-ink-primary mb-1">
                  {bi('En attente de confirmation…', 'Waiting for confirmation…')}
                </h3>
                <p className="text-sm text-ink-secondary mb-2">
                  {bi('Validez le paiement sur votre téléphone.', 'Confirm the payment on your phone.')}
                </p>
                <p className="text-xs text-ink-tertiary mb-4 font-mono">
                  {totalForQty.toLocaleString()} FCFA · {trimmedMomo}
                </p>
                {activeDepositId && (
                  <p className="text-[10px] text-ink-tertiary font-mono">ref: {activeDepositId.slice(0, 12)}…</p>
                )}
              </div>
            ) : payPhase === 'failed' || payPhase === 'timeout' ? (
              <div className="text-center">
                <div className="text-5xl mb-3">{payPhase === 'timeout' ? '⏱️' : '❌'}</div>
                <h3 className="font-bold text-ink-primary mb-1">
                  {payPhase === 'timeout'
                    ? bi('Paiement expiré', 'Payment expired')
                    : bi('Paiement échoué', 'Payment failed')}
                </h3>
                {reserveError && <p className="text-xs text-danger mt-2 mb-4">{reserveError}</p>}
                <button
                  onClick={() => { setPayPhase('idle'); setReserveError(''); setActiveDepositId(null); setReservationId(null); setReservationCode(null) }}
                  className="w-full bg-brand hover:bg-brand-dark text-white py-2.5 rounded-full text-sm font-semibold transition-colors mb-2"
                >
                  {bi('Réessayer', 'Try again')}
                </button>
                <button
                  onClick={() => setShowModal(false)}
                  className="block w-full text-ink-secondary text-xs py-2 hover:text-ink-primary"
                >
                  {bi('Fermer', 'Close')}
                </button>
              </div>
            ) : (
              <>
                <h3 className="font-bold text-ink-primary mb-1">
                  {payNow
                    ? <>💰 {bi('Réserver et payer', 'Reserve and pay')}</>
                    : <>📋 {bi('Réserver', 'Reserve')}</>}
                </h3>
                <p className="text-xs text-ink-tertiary mb-4">{event.title} · {dateStr}</p>

                <label className="block text-xs text-ink-secondary mb-1">
                  {bi('Nombre de places', 'Number of tickets')}
                </label>
                <select
                  value={quantity}
                  onChange={e => { setQuantity(Number(e.target.value)); clearPromo() }}
                  className="w-full border border-divider rounded-xl px-3 py-2 text-sm bg-surface mb-3"
                  disabled={submitting}
                >
                  {Array.from({ length: Math.min(10, remaining === Infinity ? 10 : remaining) }, (_, i) => i + 1).map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>

                {!me && (
                  <>
                    <label className="block text-xs text-ink-secondary mb-1">{bi('Nom', 'Name')}</label>
                    <input
                      type="text"
                      value={guestName}
                      onChange={e => setGuestName(e.target.value)}
                      className="w-full border border-divider rounded-xl px-3 py-2 text-sm bg-surface mb-3"
                      disabled={submitting}
                    />
                    <label className="block text-xs text-ink-secondary mb-1">{bi('Téléphone', 'Phone')}</label>
                    <div className="mb-3">
                      <PhoneInput
                        value={guestPhone}
                        onChange={(full) => setGuestPhone(full)}
                        defaultCountry={event?.city ? getCountryFromCity(event.city).iso : undefined}
                        disabled={submitting}
                      />
                    </div>
                  </>
                )}

                {me && (
                  <div className="bg-surface-muted rounded-xl px-3 py-2 mb-3 text-xs text-ink-secondary">
                    {me.name} · <span className="font-mono">{me.phone}</span>
                  </div>
                )}

                {payNow && (
                  <>
                    <label className="block text-xs text-ink-secondary mb-1">
                      {bi('Numéro Mobile Money', 'Mobile Money number')}
                    </label>
                    <div className="mb-1">
                      <PhoneInput
                        value={momoPhone}
                        onChange={(full) => setMomoPhone(full)}
                        defaultCountry={event?.city ? getCountryFromCity(event.city).iso : undefined}
                        disabled={submitting}
                      />
                    </div>
                    <p className="text-[11px] text-ink-tertiary mb-1.5">
                      {bi(
                        'Le paiement Mobile Money est disponible pour les numéros africains uniquement.',
                        'Mobile Money payment is available for African numbers only.',
                      )}
                    </p>
                    {trimmedMomo && !momoValid && (
                      <p className="text-xs text-danger mb-3">
                        {bi(
                          "Numéro non supporté. Utilisez MTN ou Orange.",
                          'Unsupported number. Use MTN or Orange.',
                        )}
                      </p>
                    )}
                  </>
                )}

                {/* Promo code — collapsible, above the total so the total
                    reflects any discount. */}
                {!isFree && (
                  <div className="mb-3">
                    {!promoOpen && !appliedPromo && (
                      <button
                        type="button"
                        onClick={() => setPromoOpen(true)}
                        className="text-xs font-semibold text-brand hover:text-brand-dark"
                      >
                        🎫 {bi('Code promo', 'Promo code')}
                      </button>
                    )}
                    {(promoOpen || appliedPromo) && !appliedPromo && (
                      <div>
                        <label className="block text-xs text-ink-secondary mb-1">🎫 {bi('Code promo', 'Promo code')}</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={promoInput}
                            onChange={e => setPromoInput(e.target.value.toUpperCase())}
                            placeholder={bi('Ex: EVT-A3F7', 'e.g. EVT-A3F7')}
                            className="flex-1 border border-divider rounded-xl px-3 py-2 text-sm bg-surface uppercase"
                            disabled={promoChecking || submitting}
                          />
                          <button
                            type="button"
                            onClick={applyPromo}
                            disabled={promoChecking || submitting || !promoInput.trim()}
                            className="px-3 py-2 rounded-xl text-sm font-semibold bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
                          >
                            {promoChecking ? '…' : bi('Appliquer', 'Apply')}
                          </button>
                        </div>
                        {promoError && <p className="text-xs text-danger mt-1">{promoError}</p>}
                      </div>
                    )}
                    {appliedPromo && (
                      <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                        <span className="text-xs font-semibold text-emerald-700">
                          🎫 {appliedPromo.code} — -{promoDiscount.toLocaleString()} FCFA {bi('appliqué!', 'applied!')}
                        </span>
                        <button
                          type="button"
                          onClick={clearPromo}
                          disabled={submitting}
                          className="text-xs text-emerald-700 hover:text-emerald-900 font-semibold underline"
                        >
                          {bi('Retirer', 'Remove')}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {!isFree && (
                  <div className="bg-brand-light rounded-xl px-3 py-2 mb-3 text-sm flex items-center justify-between">
                    <span className="text-brand-darker">
                      {payNow
                        ? bi('Total à payer', 'Total to pay')
                        : bi('Total (à payer sur place)', 'Total (pay at the door)')}
                    </span>
                    <span className="font-bold text-brand-darker">
                      {promoDiscount > 0 && (
                        <span className="text-ink-tertiary line-through font-normal mr-2">
                          {totalForQty.toLocaleString()}
                        </span>
                      )}
                      <span className={promoDiscount > 0 ? 'text-emerald-600' : ''}>
                        {finalTotal.toLocaleString()} FCFA
                      </span>
                    </span>
                  </div>
                )}

                {reserveError && <p className="text-xs text-danger mb-3">{reserveError}</p>}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    disabled={submitting}
                    className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-surface-muted text-ink-secondary hover:bg-divider transition-colors disabled:opacity-50"
                  >
                    {bi('Annuler', 'Cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={payNow ? submitPay : submitReserve}
                    disabled={
                      submitting
                      || (!me && (!guestName.trim() || !guestPhone.trim()))
                      || (payNow && (!trimmedMomo || !momoValid))
                    }
                    className={`flex-1 px-3 py-2 rounded-full text-sm font-semibold text-white transition-colors disabled:opacity-50 ${
                      payNow
                        ? 'bg-orange-500 hover:bg-orange-600'
                        : 'bg-brand hover:bg-brand-dark'
                    }`}
                  >
                    {submitting
                      ? bi('Envoi…', 'Sending…')
                      : payNow
                        ? `${bi('Payer', 'Pay')} ${finalTotal.toLocaleString()} FCFA`
                        : bi('Confirmer', 'Confirm')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-lg mt-0.5 flex-shrink-0">{icon}</span>
      <div>
        <p className="text-xs text-ink-tertiary font-medium uppercase tracking-wide">{label}</p>
        <p className="text-sm text-ink-primary font-medium mt-0.5">{value}</p>
      </div>
    </div>
  )
}
