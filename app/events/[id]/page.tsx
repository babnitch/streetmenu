'use client'
import { track } from '@/lib/track'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { PUBLIC_EVENT_SELECT } from '@/lib/publicColumns'
import { Event } from '@/types'
import { useLanguage, useBi, pickBi } from '@/lib/languageContext'
import { categoryLabel } from '@/lib/categoryLabels'
import TopNav from '@/components/TopNav'
import { loginHref as loginGate } from '@/lib/lastPhone'
import EventSocialPanel from '@/components/EventSocialPanel'
import ReportButton from '@/components/ReportButton'
import PhoneInput from '@/components/PhoneInput'
import { getCountryFromCity } from '@/lib/phoneValidation'
import { normalizeMode, modeFromLegacy, effectiveWebMode, canPayOnline, canReserve } from '@/lib/paymentMode'
import { effectiveEventMode, type EventBooking } from '@/lib/modules'
import { isPastEvent, PAST_EVENT_MESSAGE_FR, PAST_EVENT_MESSAGE_EN, formatEventDates, formatEventWhen, formatEventEnd, formatEventDay, isMultiDay, defaultBookingDay, eventDays } from '@/lib/eventDate'
import EventPoster from '@/components/events/EventPoster'
import { FEW_SEATS_MAX, FEW_SEATS_SHARE } from '@/lib/eventStatus'
import { localDayISO } from '@/lib/eventCalendar'
import type { DayAvailability } from '@/lib/eventSeats'
import { formatAmount, formatFCFA } from '@/lib/money'

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
  const router = useRouter()
  const { t, locale } = useLanguage()
  const bi = useBi()
  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState<SessionUser | null>(null)
  // Tracks whether /api/auth/me has answered yet, so the Reserve button can
  // wait instead of flashing the login prompt at a customer who *is* signed in.
  const [meLoaded, setMeLoaded] = useState(false)
  // Shown when a signed-out visitor taps Reserve / Reserve and pay.
  const [loginPrompt, setLoginPrompt] = useState(false)

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

  // Seats per day and per tier (capacity is per day). null until loaded, or
  // when the endpoint failed — the page then falls back to the event-wide
  // counters, and the booking API still enforces the real limit.
  const [availability, setAvailability] = useState<DayAvailability[] | null>(null)
  // The organiser's modules (M4): no Réservations → contact the organiser;
  // no Billets payants → book and pay at the door. null = unknown yet.
  const [booking, setBooking] = useState<EventBooking | null>(null)
  // The day this page books (multi-day events). Nothing is pre-selected: the
  // page shows its date list until the visitor taps a day, which puts
  // ?date= in the address (so Back / "Changer de date" return to the list,
  // and a login return lands back on that day). Never chosen automatically.
  const [requestedDay, setRequestedDay] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('date'))
  useEffect(() => {
    const onPop = () => setRequestedDay(new URLSearchParams(window.location.search).get('date'))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const loadAvailability = useCallback(async () => {
    try {
      const r = await fetch(`/api/events/${id}/availability`, { cache: 'no-store' })
      const d = await r.json()
      if (r.ok && Array.isArray(d?.days)) setAvailability(d.days)
      if (r.ok && d?.booking) setBooking(d.booking)
    } catch { /* keep the counter fallback */ }
  }, [id])
  useEffect(() => { loadAvailability() }, [loadAvailability])

  // Reservation modal state
  const [showModal, setShowModal] = useState(false)
  const [quantity, setQuantity] = useState(1)
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
      const { data } = await supabase.from('events').select(PUBLIC_EVENT_SELECT).eq('id', id).single().overrideTypes<Event, { merge: false }>()
      setEvent(data)
      if (data) track('view', 'event', id, data.city)
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

  // Booking day. Multi-day: only a day the visitor picked (?date=) that is
  // still to come — otherwise none, and the date list shows. Single day: its
  // day, booked directly.
  useEffect(() => {
    if (!event) return
    const today = localDayISO()
    if (isMultiDay(event)) {
      const upcoming = eventDays(event).filter(d => d >= today)
      setSelectedDay(requestedDay && upcoming.includes(requestedDay) ? requestedDay : null)
    } else {
      setSelectedDay(defaultBookingDay(event, null, today))
    }
  }, [event, requestedDay])

  // Tap a date row → booking for that day; "Changer de date" → the list.
  const chooseDate = useCallback((day: string | null) => {
    const url = new URL(window.location.href)
    if (day) url.searchParams.set('date', day); else url.searchParams.delete('date')
    window.history.pushState({}, '', url)
    setRequestedDay(day)
    setTierQty({})
    setQuantity(1)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => { if (data?.user?.role === 'customer') setMe(data.user) })
      .catch(() => null)
      .finally(() => setMeLoaded(true))
  }, [])

  // Resume a booking the login gate interrupted. A signed-out visitor who taps
  // Reserve is sent to /login?return=/events/<id>?reserve=1 (or =pay) and
  // lands back here with the form already open, instead of having to find the
  // button again. Read synchronously on mount, like the ?tab= handling in
  // /account, so the flag is known before the first paint.
  const [resumeIntent, setResumeIntent] = useState<'reserve' | 'pay' | null>(() => {
    if (typeof window === 'undefined') return null
    const raw = new URLSearchParams(window.location.search).get('reserve')
    return raw === 'pay' ? 'pay' : raw === '1' ? 'reserve' : null
  })

  // Opening the booking form is pure state, so the resume effect below can
  // call it as well as the button.
  const startReservation = useCallback((pay: boolean) => {
    setPayNow(pay)
    setQuantity(1)
    setReserveError('')
    setReservationId(null)
    setReservationCode(null)
    setPromoOpen(false)
    setPromoInput('')
    setPromoError('')
    setAppliedPromo(null)
    setMomoPhone('')
    setPayPhase('idle')
    setActiveDepositId(null)
    setShowModal(true)
  }, [])

  // The flag arrives before the session check and the event do, so wait for
  // both. The query is cleared first, so a refresh doesn't reopen the form.
  useEffect(() => {
    if (!resumeIntent || !meLoaded) return
    if (me && !event) return                       // signed in, event still loading
    const url = new URL(window.location.href)
    url.searchParams.delete('reserve')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    setResumeIntent(null)
    // Still signed out (they backed out of login) — the flag is cleared above
    // and nothing opens.
    if (me && event) startReservation(resumeIntent === 'pay')
  }, [resumeIntent, meLoaded, me, event, startReservation])

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

  // Dates alone for the share text and the booking modal; dates + time for the
  // details row, plus a "Fin" row when the event spans several days.
  const dateStr = formatEventDates(event, locale, 'detail')
  const whenStr = formatEventWhen(event, locale, 'detail')
  const endStr  = formatEventEnd(event, locale, 'detail')

  // Reservation gating + price display all derive from a single source of
  // truth so the button copy and the modal stay in lockstep.
  const hasTiers     = tiers.length > 0
  const ticketPrice  = Number(event.ticket_price ?? event.price ?? 0) || 0
  const isFree       = hasTiers
    ? tiers.every(t => t.price === 0)
    : ticketPrice === 0
  const maxTickets   = Number(event.max_tickets ?? 0)
  // Capacity is per day. With availability loaded, seats come from the
  // selected day and the event is sold out only when EVERY remaining day is
  // full. Without it (still loading / failed), fall back to the event-wide
  // counters; the booking API enforces the real per-day limit either way.
  const multiDay     = isMultiDay(event)
  const futureDays   = availability ? availability.filter(d => !d.past) : []
  const dayAv        = availability && selectedDay ? availability.find(d => d.date === selectedDay) ?? null : null
  const ticketsSold  = Number(event.tickets_sold ?? 0)
  const remaining    = availability
    ? (dayAv?.remaining ?? Infinity)
    : maxTickets > 0 ? Math.max(0, maxTickets - ticketsSold) : Infinity
  const soldOut      = availability
    ? futureDays.length > 0 && futureDays.every(d => d.soldOut)
    : maxTickets > 0 && remaining <= 0
  const daySoldOut   = !!dayAv?.soldOut
  const tierLeft = (tierId: string): number | null => {
    const t = dayAv?.tiers.find(x => x.tier_id === tierId)
    return t ? t.remaining : null
  }
  const dayLabel = (d: string) => formatEventDay(d, locale, 'compact')
  // "mer. 28 oct." on the buttons of a multi-day event.
  const dayShort = multiDay && selectedDay ? formatEventDay(selectedDay, locale, 'list') : null
  // The cheapest price still on sale for a day (multi-day date list), and
  // "Billets dès X FCFA" over the days still to come.
  const dayFromPrice = (d: DayAvailability): number | null => {
    if (d.soldOut) return null
    if (!tiers.length) return ticketPrice
    const open = tiers.filter(tt => !d.tiers.find(x => x.tier_id === tt.id)?.soldOut)
    return open.length ? Math.min(...open.map(tt => tt.price)) : null
  }
  const ticketsFrom: number | null = (() => {
    const prices = (availability ? futureDays.map(dayFromPrice) : [tiers.length ? Math.min(...tiers.map(tt => tt.price)) : ticketPrice])
      .filter((p): p is number => p !== null)
    return prices.length ? Math.min(...prices) : null
  })()
  // I6: "Infos seulement" — a third-party event: no booking here, the
  // price as text and a "Billets / Infos" link.
  const infoOnly     = event.booking_mode === 'info'
  const rawPrice     = event.ticket_price ?? event.price
  const infoPrice: string | null = rawPrice == null ? null
    : Number(rawPrice) > 0
      ? (event.price_is_from ? `${bi('À partir de', 'From')} ${formatFCFA(Number(rawPrice))}` : formatFCFA(Number(rawPrice)))
      : bi('Gratuit', 'Free')
  const showDateList = multiDay && !selectedDay && !infoOnly
  const isCancelled  = event.event_status === 'cancelled'
  const isCompleted  = event.event_status === 'completed'
  // Organizer can close the reservation gate independently of event_status —
  // e.g. soft-pause to manage walk-ins. Default is open (column default).
  const reservationsClosed = event.reservations_open === false
  // A date in the past closes bookings no matter what the organizer set —
  // the reserve/pay APIs enforce the same rule server-side.
  const isPast       = isPastEvent(event)
  const bookingOff   = booking?.reservations === false
  const reservable   = !isCancelled && !isCompleted && !soldOut && !reservationsClosed && !isPast && !bookingOff && !infoOnly
  // Resolve the 3-way payment mode (free events collapse to reservation_only).
  // reservation_only / both → reserve button; payment_only / both → pay button.
  // For 'both', both buttons render and the customer chooses.
  const paymentMode  = effectiveEventMode(effectiveWebMode(
    normalizeMode(event.payment_mode ?? modeFromLegacy(event.payment_enabled)),
    isFree,
  ), booking)
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
  // One PawaPay deposit buys exactly one tier (/pay takes a single tier_id),
  // so paid checkout is blocked when more than one tier is selected rather
  // than silently charging for the first tier only.
  // TODO: multi-tier paid checkout (one deposit covering several tiers).
  const multiTierPay = hasTiers && selectedTierItems.length > 1
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

  // Login gate target — /account honours ?return= for same-site paths (its
  // safeReturnUrl rejects anything else) and bounces back here once the
  // session cookie is set. The resume flag rides along INSIDE the return path,
  // so the booking form reopens on arrival.
  const loginHref = (intent: 'reserve' | 'pay') =>
    loginGate(`/events/${event.id}?${multiDay && selectedDay ? `date=${selectedDay}&` : ''}reserve=${intent === 'pay' ? 'pay' : '1'}`)

  function openReserve(pay: boolean) {
    // Booking requires an account (the API returns 401 otherwise). Anyone can
    // read the page; a signed-out visitor goes STRAIGHT to the login gate —
    // one tap, one intent — and comes back with the form open. The buttons
    // stay disabled until /api/auth/me answers, so a null `me` here really
    // does mean signed out rather than "not checked yet".
    if (!me) {
      router.push(loginHref(pay ? 'pay' : 'reserve'))
      return
    }
    startReservation(pay)
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
          const { data: refreshed } = await supabase.from('events').select(PUBLIC_EVENT_SELECT).eq('id', event!.id).single().overrideTypes<Event, { merge: false }>()
          if (refreshed) setEvent(refreshed)
          loadAvailability()
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
    if (!trimmedMomo || !momoValid || multiTierPay) return
    setSubmitting(true)
    setReserveError('')
    try {
      // Paid checkout buys one tier per PawaPay deposit; multiTierPay
      // blocks the button upstream, so there is exactly one item here.
      const tierItem = selectedTierItems[0]
      const body: Record<string, unknown> = {
        quantity:    hasTiers ? (tierItem?.quantity ?? 1) : quantity,
        phoneNumber: trimmedMomo,
        event_date:  selectedDay ?? undefined,
        // Site language at booking time — the API confirms in this language
        // (and syncs it onto the customer's account) so a customer browsing
        // in French never gets an English confirmation.
        locale,
      }
      if (hasTiers && tierItem) body.tier_id = tierItem.tier_id
      if (appliedPromo) body.voucher_code = appliedPromo.code
      // What the page shows; the server refuses when its own total differs.
      body.expected_total = finalTotal
      const res = await fetch(`/api/events/${event!.id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        // Session expired between opening the modal and submitting — send
        // them through the login gate instead of showing a payment error.
        if (res.status === 401 || data?.login_required) {
          setShowModal(false)
          setLoginPrompt(true)
          return
        }
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
        ? { items: selectedTierItems.map(i => ({ tier_id: i.tier_id, quantity: i.quantity })), locale }
        : { quantity, locale }
      if (selectedDay) body.event_date = selectedDay
      if (appliedPromo) body.voucher_code = appliedPromo.code
      body.expected_total = finalTotal
      const res = await fetch(`/api/events/${event!.id}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        if (res.status === 401 || data?.login_required) {
          setShowModal(false)
          setLoginPrompt(true)
          return
        }
        setReserveError(data.error ?? bi('Erreur de réservation', 'Reservation error'))
        return
      }
      setReservationId(data.reservation_id)
      setReservationCode(data.reservation_code ?? null)
      // Re-fetch event so the remaining counter reflects the new sale.
      const { data: refreshed } = await supabase.from('events').select(PUBLIC_EVENT_SELECT).eq('id', event!.id).single().overrideTypes<Event, { merge: false }>()
      if (refreshed) setEvent(refreshed)
      loadAvailability()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />

      {/* Poster header */}
      <div className="max-w-xl mx-auto px-4 pt-4">
        <Link href="/events" className="inline-flex items-center gap-1 text-sm font-semibold text-ink-secondary hover:text-ink-primary">
          {t('evt.back')}
        </Link>
        <div className="mt-3 flex gap-4 items-start">
          <EventPoster src={event.cover_photo} title={event.title} category={event.category}
            className="w-32 sm:w-40 aspect-[4/5] flex-shrink-0 shadow-card" sizes="160px" priority />
          <div className="min-w-0 pt-1">
            <span className="inline-block bg-brand text-white text-[11px] font-bold px-2.5 py-0.5 rounded-full">
              {categoryLabel(event.category, locale)}
            </span>
            {isPast && (
              <span className="inline-block ml-2 bg-ink-primary text-white text-[11px] font-bold px-2.5 py-0.5 rounded-full">
                ⏳ {bi('Passé', 'Past')}
              </span>
            )}
            <h1 className="text-xl sm:text-2xl font-black text-ink-primary leading-tight mt-2">{event.title}</h1>
            <p className="text-sm text-ink-secondary mt-1">📅 {dateStr}</p>
            {event.venue && <p className="text-sm text-ink-secondary">📍 {event.venue}</p>}
            {infoOnly ? infoPrice && (
              <p className="text-sm font-bold text-ink-primary mt-1">{infoPrice}</p>
            ) : ticketsFrom !== null && (
              <p className="text-sm font-bold text-ink-primary mt-1">
                {ticketsFrom === 0 ? bi('Gratuit', 'Free') : `${bi('Billets dès', 'Tickets from')} ${formatFCFA(ticketsFrom)}`}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-xl mx-auto px-4 py-6 space-y-6">
        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3">
          <DetailRow icon="📅" label={t('evt.date')} value={whenStr} />
          {endStr && <DetailRow icon="🏁" label={bi('Fin', 'Ends')} value={endStr} />}
          {event.venue && (
            <DetailRow
              icon="📍"
              label={t('evt.venue')}
              value={`${event.venue}${event.neighborhood ? `, ${event.neighborhood}` : ''}${event.city ? ` — ${event.city}` : ''}`}
            />
          )}
          {infoOnly ? infoPrice && <DetailRow icon="🎟" label={t('evt.price')} value={infoPrice} /> : <DetailRow
            icon="🎟"
            label={t('evt.price')}
            value={
              isFree
                ? t('evt.free')
                : `${formatFCFA(ticketPrice)}${bi(' / personne', ' / person')}`
            }
          />}
          {!infoOnly && maxTickets > 0 && !soldOut && remaining !== Infinity && (
            <DetailRow
              icon="👥"
              label={bi('Disponibilité', 'Availability')}
              value={daySoldOut
                ? `${bi('Épuisé', 'Sold out')}${multiDay && selectedDay ? ` — ${dayLabel(selectedDay)}` : ''}`
                : `${remaining} ${bi('places restantes', 'spots remaining')}${multiDay && selectedDay ? ` — ${dayLabel(selectedDay)}` : ''}`}
            />
          )}
        </div>

        {(event.description || event.organizer_name) && (
          <div className="bg-white rounded-2xl p-4 shadow-sm">
            {event.description && (
              <>
                <h2 className="text-sm font-bold text-ink-primary mb-1.5">{bi('À propos', 'About')}</h2>
                <p className="text-ink-primary text-sm leading-relaxed whitespace-pre-wrap">{event.description}</p>
              </>
            )}
            {event.organizer_name && (
              <p className={`text-sm text-ink-secondary ${event.description ? 'mt-3 pt-3 border-t border-divider' : ''}`}>
                {bi('Organisé par', 'Organised by')} <span className="font-semibold text-ink-primary">{event.organizer_name}</span>
              </p>
            )}
          </div>
        )}

        {/* I6: info only — tickets / info are elsewhere. */}
        {infoOnly && !isCancelled && !isPast && (
          <div className="bg-white rounded-2xl shadow-sm p-4">
            <p className="text-sm text-ink-secondary mb-3">
              {bi('Pas de réservation sur Tchop & Ndjoka pour cet événement.', 'No booking on Tchop & Ndjoka for this event.')}
            </p>
            {event.info_link && (
              <a href={event.info_link} target="_blank" rel="noopener noreferrer" onClick={() => track('click_tickets', 'event', event.id, event.city)}
                className="flex items-center justify-center gap-2 bg-brand hover:bg-brand-dark text-white py-3.5 rounded-2xl text-sm font-bold transition-colors shadow-card">
                🎟️ {bi('Billets / Infos', 'Tickets / Info')} ↗
              </a>
            )}
          </div>
        )}

        {/* Status banners — replaces the Reserve button when the event
            can't accept new reservations. */}
        {isCancelled && (
          <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 text-center text-sm font-semibold text-rose-700">
            {bi('❌ Événement annulé', '❌ Event cancelled')}
          </div>
        )}
        {!isCancelled && isPast && (
          <div className="bg-surface-muted border border-divider rounded-2xl p-4 text-center text-sm font-semibold text-ink-secondary">
            ⏳ {bi(`${PAST_EVENT_MESSAGE_FR}.`, `${PAST_EVENT_MESSAGE_EN}.`)}
          </div>
        )}
        {!isCancelled && !isPast && isCompleted && (
          <div className="bg-surface-muted border border-divider rounded-2xl p-4 text-center text-sm font-semibold text-ink-secondary">
            {bi('🏁 Événement terminé', '🏁 Event ended')}
          </div>
        )}
        {!isCancelled && !isPast && !isCompleted && soldOut && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center text-sm font-semibold text-amber-700">
            {bi('🎟 Épuisé', '🎟 Sold out')}
          </div>
        )}
        {/* Basic event page (no Réservations module): book with the organiser. */}
        {!isCancelled && !isPast && !isCompleted && bookingOff && !infoOnly && (() => {
          const wa = (event.whatsapp ?? '').replace(/\D/g, '')
          if (!wa) return null
          const text = bi(`Bonjour, je voudrais réserver pour « ${event.title} ».`, `Hello, I'd like to book for "${event.title}".`)
          return (
            <div className="bg-white rounded-2xl shadow-sm p-4">
              <p className="text-sm font-bold text-ink-primary mb-3">{bi('Réservez auprès de l\'organisateur', 'Book with the organiser')}</p>
              <div className="grid grid-cols-1 gap-2">
                <a href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer" onClick={() => track('click_whatsapp', 'event', event.id, event.city)}
                  className="flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-full font-semibold text-sm transition-colors">
                  💬 {bi('Contacter sur WhatsApp', 'Contact on WhatsApp')}
                </a>
                <a href={`tel:+${wa}`} onClick={() => track('click_call', 'event', event.id, event.city)}
                  className="flex items-center justify-center gap-2 bg-surface border border-divider hover:bg-surface-muted text-ink-primary py-3 rounded-full font-semibold text-sm transition-colors">
                  📞 {bi('Appeler', 'Call')}
                </a>
              </div>
            </div>
          )
        })()}
        {!isCancelled && !isPast && !isCompleted && !soldOut && reservationsClosed && !bookingOff && !infoOnly && (
          <div className="bg-surface-muted border border-divider rounded-2xl p-4 text-center text-sm font-semibold text-ink-secondary">
            🔒 {bi('Les réservations sont fermées.', 'Reservations are closed.')}
          </div>
        )}

        {/* Date list — multi-day events, until a day is chosen. One row per
            day still to come; a full day is greyed out and can't be tapped. */}
        {showDateList && !isCancelled && !isPast && (
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
            <p className="px-4 pt-4 pb-2 text-sm font-bold text-ink-primary">🗓️ {bi('Choisissez une date', 'Pick a date')}</p>
            <ul className="divide-y divide-divider">
              {(availability ? futureDays : eventDays(event).filter(d => d >= localDayISO()).map(date => ({ date } as DayAvailability))).map(d => {
                const full = !!d.soldOut
                const price = availability ? dayFromPrice(d) : null
                const few = d.remaining != null && d.capacity > 0 && !full
                  && (d.remaining <= FEW_SEATS_MAX || d.remaining <= d.capacity * FEW_SEATS_SHARE)
                const dt = new Date(`${d.date}T00:00:00Z`)
                const tag = locale === 'en' ? 'en-GB' : 'fr-FR'
                return (
                  <li key={d.date}>
                    <button type="button" disabled={full || !reservable} onClick={() => chooseDate(d.date)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-muted disabled:hover:bg-transparent disabled:opacity-50 disabled:cursor-not-allowed">
                      <span className="w-12 flex-shrink-0 rounded-xl bg-surface-muted flex flex-col items-center py-1.5">
                        <span className="text-lg font-black text-ink-primary leading-none">{Number(d.date.slice(8))}</span>
                        <span className="text-[10px] font-bold text-brand-darker uppercase">
                          {new Intl.DateTimeFormat(tag, { month: 'short', timeZone: 'UTC' }).format(dt).replace('.', '')}
                        </span>
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-semibold text-ink-primary capitalize">
                          {new Intl.DateTimeFormat(tag, { weekday: 'long', timeZone: 'UTC' }).format(dt)}{event.time ? ` · ${event.time.slice(0, 5)}` : ''}
                        </span>
                        {price !== null && (
                          <span className="block text-xs text-ink-secondary">
                            {price === 0 ? bi('Gratuit', 'Free') : `${bi('Dès', 'From')} ${formatFCFA(price)}`}
                          </span>
                        )}
                      </span>
                      <span className={`text-xs font-semibold flex-shrink-0 ${full ? 'text-danger' : few ? 'text-amber-700' : 'text-emerald-700'}`}>
                        {full ? bi('Épuisé', 'Sold out')
                          : few ? (locale === 'en' ? `Only ${d.remaining} left` : `Plus que ${d.remaining}`)
                            : bi('Disponible', 'Available')}
                      </span>
                      {!full && <span className="text-ink-tertiary" aria-hidden="true">›</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Booking day — multi-day events sell seats per day. The day was
            tapped in the date list; "Changer de date" goes back to it. */}
        {multiDay && reservable && selectedDay && (
          <div className="bg-white rounded-2xl shadow-sm p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-primary">
                📅 {bi('Réservation pour', 'Booking for')} {formatEventDay(selectedDay, locale, 'detail')}
              </p>
              {daySoldOut && (
                <span className="inline-block mt-1 text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5 rounded-full">
                  🔴 {bi('Épuisé', 'Sold out')}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => chooseDate(null)}
              className="flex-shrink-0 text-xs font-semibold text-brand hover:text-brand-dark underline underline-offset-2"
            >
              {bi('Changer de date', 'Change date')}
            </button>
          </div>
        )}

        {/* Tier picker — only when the event has tiers AND we can still
            sell. Per-tier qty stepper, total at the bottom, modal opens
            once at least one tier is selected. Remaining is for the
            selected day. */}
        {hasTiers && reservable && !showDateList && (
          <div className="space-y-2">
            {tiers.map(t => {
              const displayName = locale === 'en' && t.name_en ? t.name_en : t.name
              const remaining = t.max_quantity > 0 ? tierLeft(t.id) : null
              const tierSoldOut = remaining === 0 || daySoldOut
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
                          ? (multiDay ? bi('🔴 Épuisé ce jour', '🔴 Sold out this day') : bi('🔴 Épuisé', '🔴 Sold out'))
                          : remaining !== null
                            ? `👥 ${remaining}/${t.max_quantity} ${bi('restants', 'left')}`
                            : `👥 ${bi('Places disponibles', 'Available')}`}
                      </p>
                    </div>
                    <p className="text-sm font-bold text-brand-darker flex-shrink-0">
                      {t.price === 0 ? bi('Gratuit', 'Free') : `${formatFCFA(t.price)}`}
                    </p>
                  </div>
                  {!tierSoldOut && (
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <button
                        type="button"
                        onClick={() => { setTierQty(prev => ({ ...prev, [t.id]: Math.max(0, (prev[t.id] ?? 0) - 1) })); clearPromo() }}
                        disabled={qty === 0}
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-surface-muted text-ink-primary text-sm font-bold disabled:opacity-50"
                      >
                        −
                      </button>
                      <span className="w-6 text-center text-sm font-semibold tabular-nums">{qty}</span>
                      <button
                        type="button"
                        onClick={() => { setTierQty(prev => ({ ...prev, [t.id]: (prev[t.id] ?? 0) + 1 })); clearPromo() }}
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
        {onlineReservable && !showDateList && (
          <button
            onClick={() => openReserve(false)}
            disabled={!meLoaded || daySoldOut || (me != null && hasTiers && tierTotalQty === 0)}
            className="block w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white text-center py-3.5 rounded-2xl text-sm font-bold transition-colors shadow-card"
          >
            {/* Signed-out visitors get an explicit label — the tap opens the
                login prompt rather than the booking form. */}
            {!me ? (
              <>🔐 {bi('Connectez-vous pour réserver', 'Log in to reserve')}</>
            ) : daySoldOut ? (
              <>🔴 {multiDay ? bi('Épuisé ce jour', 'Sold out this day') : bi('Épuisé', 'Sold out')}</>
            ) : dayShort ? (
              <>
                📋 {bi('Réserver pour le', 'Reserve for')} {dayShort}
                {(hasTiers ? tierTotalPrice > 0 : !isFree) && (
                  <span className="block text-xs font-normal opacity-90 mt-0.5">
                    {hasTiers
                      ? `${formatFCFA(tierTotalPrice)}`
                      : `${bi('Paiement sur place', 'Pay at the door')} · ${formatFCFA(ticketPrice)}${bi(' / personne', ' / person')}`}
                  </span>
                )}
                {hasTiers && tierTotalQty === 0 && (
                  <span className="block text-xs font-normal opacity-90 mt-0.5">{bi('Sélectionnez un tarif', 'Pick a tier')}</span>
                )}
              </>
            ) : hasTiers ? (
              tierTotalQty === 0
                ? bi('Sélectionnez un tarif', 'Pick a tier')
                : tierTotalPrice === 0
                  ? bi('📋 Réserver gratuitement', '📋 Reserve free')
                  : `📋 ${bi('Réserver', 'Reserve')} ${formatFCFA(tierTotalPrice)}`
            ) : (
              <>
                📋 {bi('Réserver', 'Reserve')}
                {!isFree && (
                  <span className="block text-xs font-normal opacity-90 mt-0.5">
                    {bi('Paiement sur place', 'Pay at the door')} · {formatFCFA(ticketPrice)}{bi(' / personne', ' / person')}
                  </span>
                )}
              </>
            )}
          </button>
        )}

        {/* Paid online reservation — PawaPay flow. One deposit buys one
            tier, so the button is disabled while several are selected. */}
        {onlinePayReservable && !showDateList && (
          <button
            onClick={() => openReserve(true)}
            disabled={!meLoaded || daySoldOut || (me != null && hasTiers && (tierTotalQty === 0 || multiTierPay))}
            className="block w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-center py-3.5 rounded-2xl text-sm font-bold transition-colors shadow-card"
          >
            {me
              ? <>💰 {bi('Réserver et payer', 'Reserve and pay')}{dayShort ? ` — ${dayShort}` : ''}</>
              : <>🔐 {bi('Connectez-vous pour payer', 'Log in to pay')}</>}
            <span className="block text-xs font-normal opacity-90 mt-0.5">
              {hasTiers
                ? (multiTierPay
                    ? bi('Un seul tarif par paiement', 'One tier per payment')
                    : tierTotalPrice > 0 ? `${formatFCFA(tierTotalPrice)}` : bi('Sélectionnez un tarif', 'Pick a tier'))
                : `${formatFCFA(ticketPrice)}${bi(' / personne', ' / person')}`}
            </span>
          </button>
        )}

        {whatsappNumber && (
          <a
            href={whatsappUrl}
            onClick={() => track('click_whatsapp', 'event', event.id, event.city)}
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

      {/* Login gate — shown when a signed-out visitor taps Reserve. The page
          itself is public; only the booking action needs an account. */}
      {loginPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setLoginPrompt(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 text-center"
            onClick={e => e.stopPropagation()}
          >
            <div className="text-5xl mb-3">🔐</div>
            <h3 className="font-bold text-ink-primary text-lg mb-1">
              {bi('Connectez-vous pour réserver', 'Log in to reserve')}
            </h3>
            <p className="text-sm text-ink-secondary mb-4">
              {bi(
                'Votre réservation et son code sont rattachés à votre compte.',
                'Your reservation and its code are tied to your account.',
              )}
            </p>
            <Link
              href={loginHref(payNow ? 'pay' : 'reserve')}
              className="block w-full bg-brand hover:bg-brand-dark text-white py-2.5 rounded-full text-sm font-semibold transition-colors"
            >
              {bi('Se connecter', 'Log in')}
            </Link>
            <button
              onClick={() => setLoginPrompt(false)}
              className="block w-full text-ink-secondary text-xs py-2 mt-2 hover:text-ink-primary"
            >
              {bi('Plus tard', 'Later')}
            </button>
          </div>
        </div>
      )}

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
                  {formatFCFA(finalTotal)} · {trimmedMomo}
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
                <p className="text-xs text-ink-tertiary mb-4">
                  {event.title} · {multiDay && selectedDay ? formatEventDay(selectedDay, locale, 'detail') : dateStr}
                </p>

                {/* Tier events: the quantities were picked in the tier
                    steppers and are what gets submitted, so show them
                    read-only. The legacy dropdown is for untiered events. */}
                {hasTiers ? (
                  <div className="bg-surface-muted rounded-xl px-3 py-2 mb-3 text-sm text-ink-primary space-y-0.5">
                    {selectedTierItems.map(i => {
                      const t = tiers.find(x => x.id === i.tier_id)
                      const name = t ? (locale === 'en' && t.name_en ? t.name_en : t.name) : ''
                      return <p key={i.tier_id}>🎫 {name} × {i.quantity}</p>
                    })}
                  </div>
                ) : (
                  <>
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
                  </>
                )}

                {/* The modal only opens for a signed-in customer, so the
                    booking is always made under this account. */}
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
                          🎫 {appliedPromo.code} — -{formatFCFA(promoDiscount)} {bi('appliqué!', 'applied!')}
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
                          {formatAmount(totalForQty)}
                        </span>
                      )}
                      <span className={promoDiscount > 0 ? 'text-emerald-600' : ''}>
                        {formatFCFA(finalTotal)}
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
                      || !me
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
                        ? `${bi('Payer', 'Pay')} ${formatFCFA(finalTotal)}`
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
