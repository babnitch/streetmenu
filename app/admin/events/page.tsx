'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Event } from '@/types'
import { useLanguage, useBi } from '@/lib/languageContext'
import { categoryLabel } from '@/lib/categoryLabels'

// Aggregate counters keyed by event id. Loaded once per fetchEvents in a
// single query so the table can render reservation + revenue per row without
// per-event roundtrips.
interface EventAggregate { reservations_count: number; tickets_count: number; revenue: number; commission: number }
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
  const [tab, setTab] = useState<'pending' | 'approved'>('pending')
  const [saving, setSaving] = useState<string | null>(null)
  const [currentRole, setCurrentRole] = useState<string | null>(null)

  // Only super_admin and admin may flip payment configuration (not moderator).
  const canTogglePayment = currentRole === 'super_admin' || currentRole === 'admin'

  const fetchEvents = useCallback(async () => {
    const { data } = await supabase
      .from('events')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setEvents(data)

    // Reservation aggregates — single query, group client-side. Cancelled
    // reservations are excluded from the count; only 'paid' rows contribute
    // to revenue + platform commission.
    if (data && data.length > 0) {
      const ids = data.map(e => e.id)
      const { data: resv } = await supabase
        .from('event_reservations')
        .select('event_id, payment_status, reservation_status, total_price, quantity, commission_amount')
        .in('event_id', ids)
      const agg: Record<string, EventAggregate> = {}
      for (const r of resv ?? []) {
        const a = agg[r.event_id] ?? { reservations_count: 0, tickets_count: 0, revenue: 0, commission: 0 }
        if (r.reservation_status !== 'cancelled') {
          a.reservations_count += 1
          a.tickets_count      += Number(r.quantity ?? 0)
        }
        if (r.payment_status === 'paid') {
          a.revenue    += Number(r.total_price ?? 0)
          a.commission += Number(r.commission_amount ?? 0)
        }
        agg[r.event_id] = a
      }
      setAggregates(agg)

      // Submitter trust info. Unique organizer_id set, single query.
      const orgIds = Array.from(new Set(data.map(e => e.organizer_id).filter(Boolean) as string[]))
      if (orgIds.length > 0) {
        const { data: subs } = await supabase
          .from('customers')
          .select('id, name, phone, events_approved_count, event_auto_approve')
          .in('id', orgIds)
        const subMap: Record<string, Submitter> = {}
        for (const s of subs ?? []) subMap[s.id] = s as Submitter
        setSubmitters(subMap)
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchEvents()
    fetch('/api/auth/me').then(r => r.json()).then(d => { if (d.user) setCurrentRole(d.user.role) }).catch(() => {})
  }, [fetchEvents])

  // ── Toggle online ticket payment (super_admin / admin only) ──
  async function togglePayment(evt: Event) {
    const next = !evt.payment_enabled
    setSaving(evt.id)
    try {
      const res = await fetch(`/api/admin/events/${evt.id}/payment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_enabled: next }),
      })
      if (res.ok) {
        setEvents(prev => prev.map(e => e.id === evt.id ? { ...e, payment_enabled: next } : e))
        showToast(next
          ? `💰 ${evt.title} — ${bi('paiement activé', 'payment enabled')}`
          : `💳 ${evt.title} — ${bi('paiement désactivé', 'payment disabled')}`)
      } else {
        const d = await res.json().catch(() => ({}))
        showToast(d.error ?? bi('Erreur', 'Error'), false)
      }
    } finally {
      setSaving(null)
    }
  }

  async function approve(id: string) {
    setSaving(id)
    try {
      // Server route handles counter + auto-approve gate + WhatsApp ping.
      const res = await fetch(`/api/admin/events/${id}/approve`, { method: 'POST' })
      if (res.ok) {
        // Refetch to surface any newly-granted trust on the submitter.
        await fetchEvents()
      }
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

  const pending  = events.filter(e => !e.is_active)
  const approved = events.filter(e => e.is_active)
  const shown = tab === 'pending' ? pending : approved

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
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-xs text-ink-secondary font-medium">{t('admin.evtPendingTab')}</p>
          <p className={`text-2xl font-bold mt-1 ${pending.length > 0 ? 'text-brand' : 'text-ink-primary'}`}>
            {pending.length}
          </p>
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-xs text-ink-secondary font-medium">{t('admin.evtApprovedTab')}</p>
          <p className="text-2xl font-bold text-ink-primary mt-1">{approved.length}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-muted p-1 rounded-xl w-fit mb-5">
        <button
          onClick={() => setTab('pending')}
          className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
            tab === 'pending' ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
          }`}
        >
          {t('admin.evtPendingTab')}
          {pending.length > 0 && (
            <span className="ml-1.5 bg-brand text-white text-xs px-1.5 py-0.5 rounded-full">
              {pending.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('approved')}
          className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
            tab === 'approved' ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
          }`}
        >
          {t('admin.evtApprovedTab')}
        </button>
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
          <p>{tab === 'pending' ? t('admin.evtNoPending') : t('admin.evtNoApproved')}</p>
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
              onTogglePayment={() => togglePayment(evt)}
              onRevokeAutoApprove={
                evt.organizer_id && submitters[evt.organizer_id]?.event_auto_approve
                  ? () => revokeAutoApprove(evt.organizer_id!)
                  : undefined
              }
              tab={tab}
              categoryDisplay={categoryLabel(evt.category, locale)}
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
              paymentEnabledLabel={bi('💰 Paiement activé', '💰 Payment enabled')}
              payAtDoorLabel={bi('💳 Paiement sur place', '💳 Pay at door')}
              freeBadgeLabel={bi('🆓 Gratuit', '🆓 Free')}
              enablePaymentLabel={bi('💰 Activer paiement', 'Enable payment')}
              disablePaymentLabel={bi('💳 Désactiver paiement', 'Disable payment')}
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
  onApprove, onReject, onTogglePayment, onRevokeAutoApprove, tab,
  approveLabel, rejectLabel, organizerLabel,
  reservationsLabel, ticketsLabel, revenueLabel, commissionLabel, netLabel,
  priceLabel, freeLabel, paymentEnabledLabel, payAtDoorLabel, freeBadgeLabel,
  enablePaymentLabel, disablePaymentLabel,
  verifiedLabel, progressLabel, revokeAutoLabel,
  categoryDisplay,
}: {
  event: Event
  aggregate?: EventAggregate
  submitter?: Submitter
  saving: boolean
  canTogglePayment: boolean
  onApprove: () => void
  onReject: () => void
  onTogglePayment: () => void
  onRevokeAutoApprove?: () => void
  tab: 'pending' | 'approved'
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
  paymentEnabledLabel: string
  payAtDoorLabel: string
  freeBadgeLabel: string
  enablePaymentLabel: string
  disablePaymentLabel: string
  verifiedLabel: string
  progressLabel: string
  revokeAutoLabel: string
  categoryDisplay: string
}) {
  const dateStr = new Date(event.date).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
  })

  const ticketPrice = Number(event.ticket_price ?? 0)
  const isFree      = !(ticketPrice > 0)
  const priceStr    = isFree ? freeLabel : `${ticketPrice.toLocaleString()} FCFA`
  const ticketsSold = Number(event.tickets_sold ?? 0)
  const maxTickets  = Number(event.max_tickets ?? 0)
  const gross       = Number(aggregate?.revenue ?? 0)
  const commission  = Number(aggregate?.commission ?? 0)
  const net         = gross - commission

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
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
              ) : event.payment_enabled ? (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">{paymentEnabledLabel}</span>
              ) : (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-surface-muted text-ink-secondary">{payAtDoorLabel}</span>
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
          {isFree ? '🆓' : event.payment_enabled ? '💰' : '💳'}{' '}
          <strong className="text-ink-primary">{isFree ? freeBadgeLabel.replace('🆓 ', '') : event.payment_enabled ? paymentEnabledLabel.replace('💰 ', '') : payAtDoorLabel.replace('💳 ', '')}</strong>
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

      {/* Actions */}
      <div className="border-t border-divider px-4 py-3 flex items-center justify-end gap-2">
        {canTogglePayment && !isFree && (
          <button
            onClick={onTogglePayment}
            disabled={saving}
            className={`px-4 py-1.5 text-xs font-semibold rounded-xl transition-colors disabled:opacity-50 mr-auto ${
              event.payment_enabled
                ? 'bg-white hover:bg-surface-muted text-ink-secondary border border-divider'
                : 'bg-emerald-600 hover:bg-emerald-700 text-white'
            }`}
          >
            {event.payment_enabled ? disablePaymentLabel : enablePaymentLabel}
          </button>
        )}
        <button
          onClick={onReject}
          disabled={saving}
          className="px-4 py-1.5 text-xs font-semibold text-danger bg-brand-light hover:bg-brand-light rounded-xl transition-colors disabled:opacity-50"
        >
          {rejectLabel}
        </button>
        {tab === 'pending' && (
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
