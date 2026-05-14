'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Event } from '@/types'
import { useLanguage, useBi } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'

// Customer session — pulled lazily so guests still get the page. Mirrors
// the pattern in /order: /api/auth/me drives the prefill, no Supabase Auth.
interface SessionUser { id: string; name: string; phone: string; role: string }

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const bi = useBi()
  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState<SessionUser | null>(null)

  // Reservation modal state
  const [showModal, setShowModal] = useState(false)
  const [quantity, setQuantity] = useState(1)
  const [guestName, setGuestName] = useState('')
  const [guestPhone, setGuestPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [reserveError, setReserveError] = useState('')
  const [reservationId, setReservationId] = useState<string | null>(null)

  useEffect(() => {
    async function fetchEvent() {
      const { data } = await supabase.from('events').select('*').eq('id', id).single()
      setEvent(data)
      setLoading(false)
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
  const ticketPrice  = Number(event.ticket_price ?? event.price ?? 0) || 0
  const isFree       = ticketPrice === 0
  const maxTickets   = Number(event.max_tickets ?? 0)
  const ticketsSold  = Number(event.tickets_sold ?? 0)
  const remaining    = maxTickets > 0 ? Math.max(0, maxTickets - ticketsSold) : Infinity
  const soldOut      = maxTickets > 0 && remaining <= 0
  const isCancelled  = event.event_status === 'cancelled'
  const isCompleted  = event.event_status === 'completed'
  const reservable   = !isCancelled && !isCompleted && !soldOut
  // Online payment lands in Batch B. For now, payment_enabled=true events
  // surface the WhatsApp contact button instead of an in-app reserve flow.
  const onlineReservable = reservable && !event.payment_enabled
  const totalForQty = ticketPrice * quantity

  const whatsappMsg = encodeURIComponent(
    `Bonjour ! Je suis intéressé(e) par votre événement "${event.title}" le ${dateStr}.`
  )
  const whatsappNumber = event.whatsapp?.replace(/[^0-9]/g, '')
  const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${whatsappMsg}`

  const shareMsg = encodeURIComponent(
    `🎉 ${event.title} — ${dateStr}${event.venue ? ` @ ${event.venue}` : ''}\nvia Ndjoka & Tchop`
  )
  const shareUrl = `https://wa.me/?text=${shareMsg}`

  function openReserve() {
    setQuantity(1)
    setReserveError('')
    setReservationId(null)
    setGuestName('')
    setGuestPhone('')
    setShowModal(true)
  }

  async function submitReserve() {
    setSubmitting(true)
    setReserveError('')
    try {
      const body: Record<string, unknown> = { quantity }
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
            {event.category}
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

        {/* Reserve button — only for events the in-app flow can handle. */}
        {onlineReservable && (
          <button
            onClick={openReserve}
            className="block w-full bg-brand hover:bg-brand-dark text-white text-center py-3.5 rounded-2xl text-sm font-bold transition-colors shadow-card"
          >
            📋 {bi('Réserver', 'Reserve')}
            {!isFree && (
              <span className="block text-xs font-normal opacity-90 mt-0.5">
                {bi('Paiement sur place', 'Pay at the door')} · {ticketPrice.toLocaleString()} FCFA{bi(' / personne', ' / person')}
              </span>
            )}
          </button>
        )}

        {/* Online payment events surface the contact button until the
            paid reservation flow lands in Batch B. */}
        {reservable && event.payment_enabled && (
          <div className="bg-brand-light border border-brand-badge/40 rounded-2xl p-3 text-xs text-brand-darker text-center">
            {bi(
              'Paiement en ligne bientôt disponible. Contactez l\'organisateur pour réserver.',
              'Online payment coming soon. Contact the organizer to reserve.',
            )}
          </div>
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
            {reservationId ? (
              <div className="text-center">
                <div className="text-5xl mb-3">✅</div>
                <h3 className="font-bold text-ink-primary text-lg mb-1">
                  {bi('Réservation confirmée!', 'Reservation confirmed!')}
                </h3>
                <p className="text-sm text-ink-secondary mb-4">
                  {bi('Un message WhatsApp vient de partir.', 'A WhatsApp message just went out.')}
                </p>
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
            ) : (
              <>
                <h3 className="font-bold text-ink-primary mb-1">
                  📋 {bi('Réserver', 'Reserve')}
                </h3>
                <p className="text-xs text-ink-tertiary mb-4">{event.title} · {dateStr}</p>

                <label className="block text-xs text-ink-secondary mb-1">
                  {bi('Nombre de places', 'Number of tickets')}
                </label>
                <select
                  value={quantity}
                  onChange={e => setQuantity(Number(e.target.value))}
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
                    <input
                      type="tel"
                      value={guestPhone}
                      onChange={e => setGuestPhone(e.target.value)}
                      placeholder="+237 6XX XXX XXX"
                      className="w-full border border-divider rounded-xl px-3 py-2 text-sm bg-surface mb-3 font-mono"
                      disabled={submitting}
                    />
                  </>
                )}

                {me && (
                  <div className="bg-surface-muted rounded-xl px-3 py-2 mb-3 text-xs text-ink-secondary">
                    {me.name} · <span className="font-mono">{me.phone}</span>
                  </div>
                )}

                {!isFree && (
                  <div className="bg-brand-light rounded-xl px-3 py-2 mb-3 text-sm flex items-center justify-between">
                    <span className="text-brand-darker">
                      {bi('Total (à payer sur place)', 'Total (pay at the door)')}
                    </span>
                    <span className="font-bold text-brand-darker">
                      {totalForQty.toLocaleString()} FCFA
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
                    onClick={submitReserve}
                    disabled={submitting || (!me && (!guestName.trim() || !guestPhone.trim()))}
                    className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-brand text-white hover:bg-brand-dark transition-colors disabled:opacity-50"
                  >
                    {submitting
                      ? bi('Réservation…', 'Reserving…')
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
