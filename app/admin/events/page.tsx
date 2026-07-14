'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { Event } from '@/types'
import { useLanguage, useBi } from '@/lib/languageContext'
import { categoryLabel } from '@/lib/categoryLabels'
import { normalizeMode, modeFromLegacy, canPayOnline, type PaymentMode } from '@/lib/paymentMode'

// Aggregate counters keyed by event id. Loaded once per fetchEvents in a
// single query so the table can render reservation + revenue per row without
// per-event roundtrips.
interface EventAggregate { reservations_count: number; tickets_count: number; revenue: number; commission: number }

// Filter tabs. Pending = awaiting approval (is_active=false); Active = live
// (is_active=true, not yet completed); Completed = event_status 'completed';
// All = everything, with pending pinned to the top.
type EventTab = 'all' | 'pending' | 'active' | 'completed'
interface Submitter { id: string; name: string; phone: string; events_approved_count: number; event_auto_approve: boolean }

// ── Toast ─────────────────────────────────────────────────────────────────────
function useToast() {
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const show = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }, [])
  return { toast, show }
}

export default function AdminEventsPage() {
  const { t, locale } = useLanguage()
  const bi = useBi()
  const { toast, show: showToast } = useToast()
  const [events, setEvents] = useState<Event[]>([])
  const [aggregates, setAggregates] = useState<Record<string, EventAggregate>>({})
  const [submitters, setSubmitters] = useState<Record<string, Submitter>>({})
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<EventTab>('pending')
  const [saving, setSaving] = useState<string | null>(null)
  const [currentRole, setCurrentRole] = useState<string | null>(null)

  // Only super_admin and admin may flip payment configuration (not moderator).
  const canTogglePayment = currentRole === 'super_admin' || currentRole === 'admin'

  const fetchEvents = useCallback(async () => {
    // Admin console needs EVERY event, including pending (is_active=false)
    // ones awaiting approval. The browser anon client can't see those (RLS
    // public_active_read: is_active = TRUE), nor read event_reservations /
    // customers (service-role-locked), so we go through the admin API route
    // which runs as supabaseAdmin and gates on the session role.
    try {
      const res = await fetch('/api/admin/events', { cache: 'no-store' })
      const d = await res.json().catch(() => ({}))
      if (Array.isArray(d?.events)) setEvents(d.events)
      if (d?.aggregates) setAggregates(d.aggregates as Record<string, EventAggregate>)
      if (d?.submitters) setSubmitters(d.submitters as Record<string, Submitter>)
    } catch { /* leave lists empty on failure */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchEvents()
    fetch('/api/auth/me').then(r => r.json()).then(d => { if (d.user) setCurrentRole(d.user.role) }).catch(() => {})
  }, [fetchEvents])

  // ── Payment config (super_admin / admin only) ──
  async function patchEventPayment(evt: Event, patch: { payment_mode?: PaymentMode; whatsapp_payment_enabled?: boolean }) {
    setSaving(evt.id)
    try {
      const res = await fetch(`/api/admin/events/${evt.id}/payment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        setEvents(prev => prev.map(e => e.id === evt.id ? { ...e, ...data } : e))
        showToast(`✅ ${evt.title} — ${bi('paiement mis à jour', 'payment updated')}`)
      } else {
        const d = await res.json().catch(() => ({}))
        showToast(d.error ?? bi('Erreur', 'Error'), false)
      }
    } finally {
      setSaving(null)
    }
  }
  const setEventMode      = (evt: Event, mode: PaymentMode) => patchEventPayment(evt, { payment_mode: mode })
  const toggleEventWhatsapp = (evt: Event, next: boolean) => patchEventPayment(evt, { whatsapp_payment_enabled: next })

  async function approve(id: string) {
    setSaving(id)
    try {
      // Server route handles counter + auto-approve gate + WhatsApp ping.
      const res  = await fetch(`/api/admin/events/${id}/approve`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      console.log('[admin/events] approve', id, '→', res.status, data)
      if (res.ok) {
        // Optimistically flip the event to active so it leaves the Pending
        // tab and every derived count (pending/active) updates instantly —
        // don't make the UI wait on (or depend on) the background refetch.
        setEvents(prev => prev.map(e => e.id === id ? { ...e, is_active: true } : e))
        showToast(bi('✅ Événement approuvé', '✅ Event approved'))
        // Refetch in the background to surface any newly-granted publisher
        // trust badge on the submitter. Non-fatal — the optimistic update
        // above already moved the event.
        fetchEvents().catch(() => {})
      } else {
        showToast(data?.error ?? bi('Erreur lors de l\'approbation', 'Approval failed'), false)
      }
    } catch (e) {
      console.error('[admin/events] approve failed:', e)
      showToast(bi('Erreur réseau lors de l\'approbation', 'Network error during approval'), false)
    } finally {
      setSaving(null)
    }
  }

  async function reject(id: string) {
    const reason = prompt(bi('Raison du rejet (optionnel):', 'Reason for rejection (optional):'), '')
    if (reason === null) return // user cancelled the prompt
    setSaving(id)
    try {
      const res = await fetch(`/api/admin/events/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || null }),
      })
      if (res.ok) {
        setEvents(prev => prev.filter(e => e.id !== id))
      }
    } finally {
      setSaving(null)
    }
  }

  async function revokeAutoApprove(customerId: string) {
    const reason = prompt(bi(
      'Raison de la révocation (optionnel):',
      'Reason for revocation (optional):',
    ), '')
    if (reason === null) return
    const res = await fetch(`/api/admin/events/revoke-auto-approve/${customerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || null }),
    })
    if (res.ok) await fetchEvents()
  }

  const isCompleted = (e: Event) => e.event_status === 'completed'
  const pending   = events.filter(e => !e.is_active)
  const active    = events.filter(e => e.is_active && !isCompleted(e))
  const completed = events.filter(isCompleted)

  // "All" pins pending events to the top so approvals never get buried under
  // the (usually larger) pile of already-live events.
  const allSorted = [...events].sort((a, b) => {
    const ap = a.is_active ? 1 : 0
    const bp = b.is_active ? 1 : 0
    return ap - bp
  })

  const shown =
    tab === 'pending'   ? pending   :
    tab === 'active'    ? active    :
    tab === 'completed' ? completed :
    allSorted

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] px-5 py-3 rounded-2xl shadow-lg text-sm font-semibold text-white transition-all ${toast.ok ? 'bg-brand' : 'bg-danger'}`}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-primary">{t('admin.evtTitle')}</h1>
        <p className="text-sm text-ink-secondary mt-0.5">{t('admin.evtSub')}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-xs text-ink-secondary font-medium">{bi('Total', 'All')}</p>
          <p className="text-2xl font-bold text-ink-primary mt-1">{events.length}</p>
        </div>
        <div className={`bg-white rounded-2xl p-4 shadow-sm ${pending.length > 0 ? 'ring-2 ring-brand' : ''}`}>
          <p className="text-xs text-ink-secondary font-medium">{bi('En attente', 'Pending')}</p>
          <p className={`text-2xl font-bold mt-1 ${pending.length > 0 ? 'text-brand' : 'text-ink-primary'}`}>
            {pending.length}
          </p>
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-xs text-ink-secondary font-medium">{bi('Actifs', 'Active')}</p>
          <p className="text-2xl font-bold text-ink-primary mt-1">{active.length}</p>
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-xs text-ink-secondary font-medium">{bi('Terminés', 'Completed')}</p>
          <p className="text-2xl font-bold text-ink-primary mt-1">{completed.length}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-muted p-1 rounded-xl w-fit mb-5 flex-wrap">
        {([
          ['all',       bi('Tous', 'All'),          events.length],
          ['pending',   bi('En attente', 'Pending'), pending.length],
          ['active',    bi('Actifs', 'Active'),      active.length],
          ['completed', bi('Terminés', 'Completed'), completed.length],
        ] as [EventTab, string, number][]).map(([value, label, count]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
              tab === value ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
            }`}
          >
            {label}
            {value === 'pending' && count > 0 && (
              <span className="ml-1.5 bg-brand text-white text-xs px-1.5 py-0.5 rounded-full">
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3 animate-bounce">🎉</div>
          <p>{t('admin.evtLoading')}</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3">📭</div>
          <p>{tab === 'pending' ? t('admin.evtNoPending') : bi('Aucun événement', 'No events')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map(evt => (
            <EventRow
              key={evt.id}
              event={evt}
              aggregate={aggregates[evt.id]}
              submitter={evt.organizer_id ? submitters[evt.organizer_id] : undefined}
              saving={saving === evt.id}
              canTogglePayment={canTogglePayment}
              onApprove={() => approve(evt.id)}
              onReject={() => reject(evt.id)}
              onSetMode={(m) => setEventMode(evt, m)}
              onToggleWhatsapp={(n) => toggleEventWhatsapp(evt, n)}
              onRevokeAutoApprove={
                evt.organizer_id && submitters[evt.organizer_id]?.event_auto_approve
                  ? () => revokeAutoApprove(evt.organizer_id!)
                  : undefined
              }
              categoryDisplay={categoryLabel(evt.category, locale)}
              pendingLabel={bi('⏳ En attente d\'approbation', '⏳ Pending approval')}
              approveLabel={t('admin.evtApproveBtn')}
              rejectLabel={t('admin.evtRejectBtn')}
              organizerLabel={t('admin.evtOrganizer')}
              reservationsLabel={bi('Réservations', 'Reservations')}
              ticketsLabel={bi('Places', 'Tickets')}
              revenueLabel={bi('Revenus', 'Revenue')}
              commissionLabel={bi('Commission', 'Commission')}
              netLabel={bi('Net organisateur', 'Organizer net')}
              priceLabel={bi('Prix billet', 'Ticket price')}
              freeLabel={bi('Gratuit', 'Free')}
              freeBadgeLabel={bi('🆓 Gratuit', '🆓 Free')}
              verifiedLabel={bi('✅ Vérifié', '✅ Verified')}
              progressLabel={bi('approuvés / 3', 'approved / 3')}
              revokeAutoLabel={bi('Révoquer auto-approbation', 'Revoke auto-approve')}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function EventRow({
  event, aggregate, submitter, saving, canTogglePayment,
  onApprove, onReject, onSetMode, onToggleWhatsapp, onRevokeAutoApprove,
  approveLabel, rejectLabel, organizerLabel,
  reservationsLabel, ticketsLabel, revenueLabel, commissionLabel, netLabel,
  priceLabel, freeLabel, freeBadgeLabel,
  verifiedLabel, progressLabel, revokeAutoLabel,
  categoryDisplay, pendingLabel,
}: {
  event: Event
  aggregate?: EventAggregate
  submitter?: Submitter
  saving: boolean
  canTogglePayment: boolean
  onApprove: () => void
  onReject: () => void
  onSetMode: (m: PaymentMode) => void
  onToggleWhatsapp: (n: boolean) => void
  onRevokeAutoApprove?: () => void
  approveLabel: string
  rejectLabel: string
  organizerLabel: string
  reservationsLabel: string
  ticketsLabel: string
  revenueLabel: string
  commissionLabel: string
  netLabel: string
  priceLabel: string
  freeLabel: string
  freeBadgeLabel: string
  verifiedLabel: string
  progressLabel: string
  revokeAutoLabel: string
  categoryDisplay: string
  pendingLabel: string
}) {
  const bi = useBi()
  const dateStr = new Date(event.date).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
  })

  const ticketPrice = Number(event.ticket_price ?? 0)
  const isFree      = !(ticketPrice > 0)
  const priceStr    = isFree ? freeLabel : `${ticketPrice.toLocaleString()} FCFA`
  // Free events are always reservation_only.
  const mode        = isFree ? 'reservation_only' : normalizeMode(event.payment_mode ?? modeFromLegacy(event.payment_enabled))
  const modeLabel   = mode === 'payment_only'
    ? bi('Paiement seul', 'Payment only')
    : mode === 'both'
      ? bi('Les deux', 'Both')
      : bi('Réservation seule', 'Reservation only')
  const ticketsSold = Number(event.tickets_sold ?? 0)
  const maxTickets  = Number(event.max_tickets ?? 0)
  const gross       = Number(aggregate?.revenue ?? 0)
  const commission  = Number(aggregate?.commission ?? 0)
  const net         = gross - commission

  // Pending (is_active=false) rows get an amber ring + banner so approvals
  // stand out from the pile of already-live events.
  const isPending = !event.is_active

  return (
    <div className={`bg-white rounded-2xl shadow-sm overflow-hidden ${isPending ? 'ring-2 ring-amber-400' : ''}`}>
      {isPending && (
        <div className="bg-amber-50 text-amber-800 text-xs font-semibold px-4 py-1.5 border-b border-amber-200">
          {pendingLabel}
        </div>
      )}
      <div className="flex gap-4 p-4">
        {/* Thumbnail */}
        <div className="w-20 h-20 flex-shrink-0 rounded-xl bg-brand-light overflow-hidden relative">
          {event.cover_photo ? (
            <Image src={event.cover_photo} alt={event.title} fill className="object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-2xl">🎉</div>
          )}
        </div>

        {/* Details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-bold text-ink-primary text-sm leading-tight">{event.title}</p>
              <p className="text-xs text-brand font-medium mt-0.5">
                📅 {dateStr}{event.time ? ` · ${event.time}` : ''}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1 flex-shrink-0">
              <span className="text-xs bg-surface-muted text-ink-secondary px-2 py-0.5 rounded-full">
                {categoryDisplay}
              </span>
              {isFree ? (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{freeBadgeLabel}</span>
              ) : mode === 'payment_only' ? (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">💰 {bi('Paiement seul', 'Payment only')}</span>
              ) : mode === 'both' ? (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">💰📋 {bi('Les deux', 'Both')}</span>
              ) : (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-surface-muted text-ink-secondary">📋 {bi('Réservation seule', 'Reservation only')}</span>
              )}
              {event.whatsapp_payment_enabled && (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">💬💰 {bi('WhatsApp', 'WhatsApp')}</span>
              )}
            </div>
          </div>

          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
            {event.venue && (
              <p className="text-xs text-ink-tertiary truncate">📍 {event.venue}, {event.city}</p>
            )}
            {event.organizer_name && (
              <p className="text-xs text-ink-tertiary">{organizerLabel}: {event.organizer_name}</p>
            )}
            {event.whatsapp && (
              <p className="text-xs text-ink-tertiary font-mono">{event.whatsapp}</p>
            )}
          </div>

          {/* Submitter trust + auto-approve revoke. Only renders when we
              successfully joined a submitter row (rejected events lose the
              organizer_id link, so this stays absent there). */}
          {submitter && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {submitter.event_auto_approve ? (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                  {verifiedLabel}
                </span>
              ) : (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                  {submitter.events_approved_count}/3 {progressLabel}
                </span>
              )}
              {onRevokeAutoApprove && (
                <button
                  onClick={onRevokeAutoApprove}
                  className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100"
                >
                  ⛔ {revokeAutoLabel}
                </button>
              )}
            </div>
          )}

          {event.description && (
            <p className="text-xs text-ink-secondary mt-1.5 line-clamp-2">{event.description}</p>
          )}
        </div>
      </div>

      {/* Ticket + revenue detail. Price / payment status / tickets sold always
          render; reservation + revenue breakdown (gross, commission, net) only
          once there's something to report. */}
      <div className="px-4 py-2 border-t border-divider bg-surface-muted flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-secondary">
        <span>🏷 {priceLabel}: <strong className="text-ink-primary">{priceStr}</strong></span>
        <span>
          {isFree ? '🆓' : mode === 'payment_only' ? '💰' : mode === 'both' ? '💰📋' : '📋'}{' '}
          <strong className="text-ink-primary">{isFree ? bi('Gratuit', 'Free') : modeLabel}</strong>
        </span>
        <span>🎟 {ticketsLabel}: <strong className="text-ink-primary">{ticketsSold}</strong>{maxTickets > 0 ? `/${maxTickets}` : ''}</span>
        {aggregate && aggregate.reservations_count > 0 && (
          <span>📋 {reservationsLabel}: <strong className="text-ink-primary">{aggregate.reservations_count}</strong></span>
        )}
        {gross > 0 && (
          <>
            <span>💰 {revenueLabel}: <strong className="text-brand">{gross.toLocaleString()} FCFA</strong></span>
            <span>📊 {commissionLabel}: <strong className="text-ink-primary">{commission.toLocaleString()} FCFA</strong></span>
            <span>🤝 {netLabel}: <strong className="text-ink-primary">{net.toLocaleString()} FCFA</strong></span>
          </>
        )}
      </div>

      {/* Payment mode control — admin/super_admin only, hidden for free events. */}
      {canTogglePayment && !isFree && (
        <div className="border-t border-divider px-4 py-3 bg-surface flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-ink-secondary mr-1">{bi('Paiement', 'Payment')}:</span>
          <div className="inline-flex rounded-xl bg-surface-muted p-0.5">
            {([
              ['reservation_only', bi('📋 Réservation', '📋 Reservation')],
              ['payment_only',     bi('💰 Paiement', '💰 Payment')],
              ['both',             bi('💰📋 Les deux', '💰📋 Both')],
            ] as [PaymentMode, string][]).map(([value, label]) => (
              <button
                key={value}
                disabled={saving}
                onClick={() => value !== mode && onSetMode(value)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60 ${
                  mode === value ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {canPayOnline(mode) && (
            <button
              disabled={saving}
              onClick={() => onToggleWhatsapp(!event.whatsapp_payment_enabled)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-60 ${
                event.whatsapp_payment_enabled
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-ink-secondary border-divider hover:bg-surface-muted'
              }`}
            >
              💬💰 {event.whatsapp_payment_enabled ? bi('WhatsApp activé', 'WhatsApp on') : bi('WhatsApp désactivé', 'WhatsApp off')}
            </button>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="border-t border-divider px-4 py-3 flex items-center justify-end gap-2">
        <button
          onClick={onReject}
          disabled={saving}
          className="px-4 py-1.5 text-xs font-semibold text-danger bg-brand-light hover:bg-brand-light rounded-xl transition-colors disabled:opacity-50"
        >
          {rejectLabel}
        </button>
        {isPending && (
          <button
            onClick={onApprove}
            disabled={saving}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-brand hover:bg-brand-dark rounded-xl transition-colors disabled:opacity-50"
          >
            {approveLabel}
          </button>
        )}
      </div>
    </div>
  )
}
