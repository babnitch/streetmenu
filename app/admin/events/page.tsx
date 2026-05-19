'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Event } from '@/types'
import { useLanguage, useBi } from '@/lib/languageContext'

// Aggregate counters keyed by event id. Loaded once per fetchEvents in a
// single query so the table can render reservation + revenue per row without
// per-event roundtrips.
interface EventAggregate { reservations_count: number; tickets_count: number; revenue: number; commission: number }
interface Submitter { id: string; name: string; phone: string; events_approved_count: number; event_auto_approve: boolean }

export default function AdminEventsPage() {
  const { t } = useLanguage()
  const bi = useBi()
  const [events, setEvents] = useState<Event[]>([])
  const [aggregates, setAggregates] = useState<Record<string, EventAggregate>>({})
  const [submitters, setSubmitters] = useState<Record<string, Submitter>>({})
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pending' | 'approved'>('pending')
  const [saving, setSaving] = useState<string | null>(null)

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
  }, [fetchEvents])

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
              onApprove={() => approve(evt.id)}
              onReject={() => reject(evt.id)}
              onRevokeAutoApprove={
                evt.organizer_id && submitters[evt.organizer_id]?.event_auto_approve
                  ? () => revokeAutoApprove(evt.organizer_id!)
                  : undefined
              }
              tab={tab}
              approveLabel={t('admin.evtApproveBtn')}
              rejectLabel={t('admin.evtRejectBtn')}
              organizerLabel={t('admin.evtOrganizer')}
              reservationsLabel={bi('Réservations', 'Reservations')}
              ticketsLabel={bi('Places', 'Tickets')}
              revenueLabel={bi('Revenus', 'Revenue')}
              commissionLabel={bi('Commission', 'Commission')}
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
  event, aggregate, submitter, saving,
  onApprove, onReject, onRevokeAutoApprove, tab,
  approveLabel, rejectLabel, organizerLabel,
  reservationsLabel, ticketsLabel, revenueLabel, commissionLabel,
  verifiedLabel, progressLabel, revokeAutoLabel,
}: {
  event: Event
  aggregate?: EventAggregate
  submitter?: Submitter
  saving: boolean
  onApprove: () => void
  onReject: () => void
  onRevokeAutoApprove?: () => void
  tab: 'pending' | 'approved'
  approveLabel: string
  rejectLabel: string
  organizerLabel: string
  reservationsLabel: string
  ticketsLabel: string
  revenueLabel: string
  commissionLabel: string
  verifiedLabel: string
  progressLabel: string
  revokeAutoLabel: string
}) {
  const dateStr = new Date(event.date).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
  })

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
            <span className="flex-shrink-0 text-xs bg-surface-muted text-ink-secondary px-2 py-0.5 rounded-full">
              {event.category === 'Enfants' ? '👶 Enfants' : event.category}
            </span>
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

      {/* Reservation aggregates — only shown when there's anything to report
          and the event has actually been approved (pending events can't have
          reservations yet, but we still render zero badges if anything snuck
          through). */}
      {aggregate && (aggregate.reservations_count > 0 || aggregate.revenue > 0) && (
        <div className="px-4 py-2 border-t border-divider bg-surface-muted flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-secondary">
          <span>📋 {reservationsLabel}: <strong className="text-ink-primary">{aggregate.reservations_count}</strong></span>
          <span>🎟 {ticketsLabel}: <strong className="text-ink-primary">{aggregate.tickets_count}</strong>{event.max_tickets && event.max_tickets > 0 ? `/${event.max_tickets}` : ''}</span>
          {aggregate.revenue > 0 && (
            <>
              <span>💰 {revenueLabel}: <strong className="text-brand">{Number(aggregate.revenue).toLocaleString()} FCFA</strong></span>
              <span>📊 {commissionLabel}: <strong className="text-ink-primary">{Number(aggregate.commission).toLocaleString()} FCFA</strong></span>
            </>
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
