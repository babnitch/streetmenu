'use client'

// "Mes événements" — the organiser's dashboard: their events, bookings,
// tiers, promo codes, settings and subscribers. Lives on /pro/events
// (moved out of /account, which now redirects ?tab=events here).

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useLanguage, useBi, pickBi } from '@/lib/languageContext'
import EventTiersPanel from '@/components/EventTiersPanel'
import EventVouchersPanel from '@/components/EventVouchersPanel'
import ConfirmModal from '@/components/ConfirmModal'
import { categoryLabel } from '@/lib/categoryLabels'
import { canPayOnline, type PaymentMode } from '@/lib/paymentMode'
import { formatEventDates, formatEventWhen, formatEventDay, isMultiDay, validateEventRange, EVENT_RANGE_ERRORS, eventDays } from '@/lib/eventDate'
import { capacityFromTiers, capacityTotalLine } from '@/lib/eventCapacity'
import { formatPhoneDisplay } from '@/lib/phoneValidation'
import { formatFCFA } from '@/lib/money'

// Event categories — kept in sync with app/events/submit/page.tsx.
const EVENT_EDIT_CATEGORIES = [
  'Concert', 'Festival', 'BT/Club', 'Sport', 'Culture', 'Gastronomie', 'Enfants', 'Business', 'Autre',
] as const

export interface MyEventsPanelEvent {
  id: string; title: string; date: string; time: string | null
  end_date: string | null; end_time: string | null
  description?: string | null; neighborhood?: string | null; category?: string | null
  venue: string | null; city: string | null; cover_photo: string | null
  notify_phone?: string | null
  ticket_price: number | null; max_tickets: number | null; tickets_sold: number | null
  payment_enabled: boolean; payment_mode?: string | null; whatsapp_payment_enabled?: boolean
  organizer_name: string | null; event_status: string | null
  is_active: boolean
  requires_confirmation?: boolean
  reservations_open?:     boolean
  reservations_count: number; tickets_count: number
  revenue: number; commission: number; net_revenue: number; pending_count: number
  pending_approval_count?: number
}
export interface MyEventsPanelTrust {
  events_submitted_count: number
  events_approved_count:  number
  event_auto_approve:     boolean
}
interface MyEventReservation {
  id: string; customer_name: string; customer_phone: string
  quantity: number; total_price: number
  payment_status: 'not_required' | 'pending' | 'paid' | 'failed'
  payment_method: string | null
  reservation_status: 'pending' | 'confirmed' | 'cancelled' | 'attended' | 'rejected'
  reservation_code: string | null
  event_date: string | null
  created_at: string
}
interface EventEditForm {
  title: string; description: string; date: string; time: string
  end_date: string; end_time: string
  venue: string; neighborhood: string; category: string
  ticket_price: string; max_tickets: string
  payment_mode: PaymentMode; whatsapp_payment_enabled: boolean
  cover_photo: string
  notify_phone: string
}

export default function MyEventsPanel({
  events, trust, onChanged,
}: {
  events: MyEventsPanelEvent[]
  trust: MyEventsPanelTrust | null
  onChanged: () => void
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reservations, setReservations] = useState<MyEventReservation[]>([])
  const [loadingResv, setLoadingResv] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  // Cancel-reservation confirmation (in-page; window.confirm() is silently
  // refused by some in-app browsers).
  const [cancelTarget, setCancelTarget] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  // Edit-event modal state.
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<EventEditForm | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editPhotoUploading, setEditPhotoUploading] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  // Message-attendees modal state.
  const [messaging, setMessaging] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [sendingMsg, setSendingMsg] = useState(false)
  const [msgResult, setMsgResult] = useState<string | null>(null)
  // Transient banner shown on the detail view after an edit saves.
  const [savedBanner, setSavedBanner] = useState<string | null>(null)
  // Reservation list filter — All / Pending / Confirmed / Attended.
  // Defaults to All so the organizer sees everything by default.
  const [resvFilter, setResvFilter] = useState<'all' | 'pending' | 'confirmed' | 'attended'>('all')
  // Inline event-setting controls (open/close, manual approval, capacity).
  // Track in-flight to disable the buttons while a PATCH is mid-air.
  const [savingSettings, setSavingSettings] = useState(false)
  const [capacityDraft, setCapacityDraft] = useState<string>('')
  // Active tiers' max per day, from EventTiersPanel. With tiers the event's
  // capacity is their sum (the server keeps max_tickets in sync), so the
  // capacity fields turn read-only. null until the panel has loaded.
  const [tierMaxes, setTierMaxes] = useState<number[] | null>(null)
  const tierMaxesRef = useRef<string | null>(null)
  const onTiersLoaded = useCallback((maxes: number[]) => {
    const key = maxes.join(',')
    const changed = tierMaxesRef.current !== null && tierMaxesRef.current !== key
    tierMaxesRef.current = key
    setTierMaxes(maxes)
    if (changed) onChanged()            // capacity moved with the tiers → refresh stats
  }, [onChanged])
  useEffect(() => { tierMaxesRef.current = null; setTierMaxes(null) }, [selectedId])

  const selected = selectedId ? events.find(e => e.id === selectedId) ?? null : null
  const selectedHasTiers = !!tierMaxes && tierMaxes.length > 0
  const selectedDayCount = selected ? eventDays(selected).length : 0
  const selectedPerDay = selectedHasTiers ? capacityFromTiers(tierMaxes!) : Number(selected?.max_tickets ?? 0)
  const editDayCount = editForm?.date
    ? eventDays({ date: editForm.date, end_date: editForm.end_date || null }).length
    : selectedDayCount

  async function openEvent(eventId: string) {
    setSelectedId(eventId)
    setLoadingResv(true)
    try {
      const r = await fetch(`/api/events/${eventId}/reservations`, { cache: 'no-store' })
      const d = await r.json()
      setReservations(Array.isArray(d?.reservations) ? d.reservations : [])
    } finally {
      setLoadingResv(false)
    }
  }

  function cancel(resId: string) {
    setCancelError(null)
    setCancelTarget(resId)
  }

  async function doCancel() {
    const resId = cancelTarget
    if (!resId || !selectedId) return
    setActing(resId)
    setCancelError(null)
    try {
      const res = await fetch(`/api/events/${selectedId}/reservations/${resId}/cancel`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        setReservations(prev => prev.map(x => x.id === resId ? { ...x, reservation_status: 'cancelled' } : x))
        setCancelTarget(null)
        onChanged()
      } else {
        setCancelError(pickBi(d?.error ?? 'Erreur — réessayez. / Error — please try again.', locale))
      }
    } catch {
      setCancelError(bi('Connexion impossible — réessayez.', 'Connection failed — please try again.'))
    } finally {
      setActing(null)
    }
  }
  const cancelRow = cancelTarget ? reservations.find(x => x.id === cancelTarget) ?? null : null

  async function attend(resId: string) {
    setActing(resId)
    try {
      const res = await fetch(`/api/events/${selectedId}/reservations/${resId}/attend`, { method: 'POST' })
      if (res.ok) {
        setReservations(prev => prev.map(x => x.id === resId ? { ...x, reservation_status: 'attended' } : x))
      }
    } finally {
      setActing(null)
    }
  }

  // New organizer actions for manual-approval flow.
  async function confirmRes(resId: string) {
    setActing(resId)
    try {
      const res = await fetch(`/api/events/${selectedId}/reservations/${resId}/confirm`, { method: 'POST' })
      if (res.ok) {
        setReservations(prev => prev.map(x => x.id === resId ? { ...x, reservation_status: 'confirmed' } : x))
        onChanged()
      }
    } finally {
      setActing(null)
    }
  }
  async function rejectRes(resId: string) {
    const reason = prompt(bi('Raison du refus (optionnel):', 'Reason for rejection (optional):'), '')
    if (reason === null) return
    setActing(resId)
    try {
      const res = await fetch(`/api/events/${selectedId}/reservations/${resId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || null }),
      })
      if (res.ok) {
        setReservations(prev => prev.map(x => x.id === resId ? { ...x, reservation_status: 'rejected' } : x))
        onChanged()
      }
    } finally {
      setActing(null)
    }
  }

  // Event-level toggles. Each PATCH refreshes the parent so the badge
  // counts in the header stay in sync with the buttons just clicked.
  async function toggleReservationsOpen() {
    if (!selected) return
    setSavingSettings(true)
    try {
      const res = await fetch(`/api/events/${selected.id}/reservations-status`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ open: !(selected.reservations_open !== false) }),
      })
      if (res.ok) onChanged()
    } finally { setSavingSettings(false) }
  }
  async function toggleRequiresConfirmation() {
    if (!selected) return
    setSavingSettings(true)
    try {
      const res = await fetch(`/api/events/${selected.id}/settings`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ requires_confirmation: !selected.requires_confirmation }),
      })
      if (res.ok) onChanged()
    } finally { setSavingSettings(false) }
  }
  async function saveCapacity() {
    if (!selected) return
    const n = Number.parseInt(capacityDraft, 10)
    if (!Number.isFinite(n) || n < 0) return
    setSavingSettings(true)
    try {
      const res = await fetch(`/api/events/${selected.id}/settings`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ max_tickets: n }),
      })
      if (res.ok) {
        setCapacityDraft('')
        onChanged()
      }
    } finally { setSavingSettings(false) }
  }

  // ── Edit event ──
  function openEdit() {
    if (!selected) return
    setEditForm({
      title:        selected.title ?? '',
      description:  selected.description ?? '',
      date:         selected.date ? String(selected.date).slice(0, 10) : '',
      time:         selected.time ?? '',
      end_date:     selected.end_date ? String(selected.end_date).slice(0, 10) : '',
      end_time:     selected.end_time ?? '',
      venue:        selected.venue ?? '',
      neighborhood: selected.neighborhood ?? '',
      category:     selected.category ?? '',
      ticket_price: selected.ticket_price != null ? String(selected.ticket_price) : '',
      max_tickets:  selected.max_tickets != null ? String(selected.max_tickets) : '',
      payment_mode: (selected.payment_mode as PaymentMode) ?? 'reservation_only',
      whatsapp_payment_enabled: !!selected.whatsapp_payment_enabled,
      cover_photo:  selected.cover_photo ?? '',
      notify_phone: selected.notify_phone ? formatPhoneDisplay(selected.notify_phone) : '',
    })
    setEditError(null)
    setEditing(true)
  }
  function setEdit<K extends keyof EventEditForm>(key: K, value: EventEditForm[K]) {
    setEditForm(prev => (prev ? { ...prev, [key]: value } : prev))
  }
  async function handleEditPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setEditPhotoUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', 'event_poster')
      fd.append('pathPrefix', 'events')
      const r = await fetch('/api/upload/image', { method: 'POST', body: fd })
      if (r.ok) {
        const j = await r.json()
        if (typeof j?.url === 'string') setEdit('cover_photo', j.url)
      }
    } finally { setEditPhotoUploading(false) }
  }
  async function saveEdit() {
    if (!selected || !editForm) return
    if (!editForm.title.trim() || !editForm.date || !editForm.category) {
      setEditError(bi('Titre, date et catégorie requis.', 'Title, date and category are required.'))
      return
    }
    const rangeError = validateEventRange({
      date: editForm.date, time: editForm.time || null,
      end_date: editForm.end_date || null, end_time: editForm.end_time || null,
    })
    if (rangeError) {
      setEditError(bi(EVENT_RANGE_ERRORS[rangeError].fr, EVENT_RANGE_ERRORS[rangeError].en))
      return
    }
    setSavingEdit(true)
    setEditError(null)
    try {
      const res = await fetch(`/api/events/${selected.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:        editForm.title,
          description:  editForm.description,
          date:         editForm.date,
          time:         editForm.time,
          end_date:     editForm.end_date || null,
          end_time:     editForm.end_time || null,
          venue:        editForm.venue,
          neighborhood: editForm.neighborhood,
          category:     editForm.category,
          ticket_price: editForm.ticket_price === '' ? null : Number(editForm.ticket_price),
          max_tickets:  editForm.max_tickets === '' ? 0 : Number(editForm.max_tickets),
          payment_mode: editForm.payment_mode,
          whatsapp_payment_enabled: editForm.whatsapp_payment_enabled,
          cover_photo:  editForm.cover_photo || null,
          notify_phone: editForm.notify_phone.trim(),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setEditError(d?.error ?? bi('Erreur', 'Error')); return }
      setEditing(false)
      setSavedBanner(
        d.notified_count > 0
          ? bi(`✅ Enregistré — ${d.notified_count} inscrit(s) notifié(s)`, `✅ Saved — ${d.notified_count} attendee(s) notified`)
          : bi('✅ Événement mis à jour', '✅ Event updated'),
      )
      setTimeout(() => setSavedBanner(null), 4000)
      onChanged()
    } finally { setSavingEdit(false) }
  }

  // ── Message attendees ──
  async function sendMessage() {
    if (!selected || !messageText.trim()) return
    setSendingMsg(true)
    setMsgResult(null)
    try {
      const res = await fetch(`/api/events/${selected.id}/message`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: messageText.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setMsgResult(d?.error ?? bi('Erreur', 'Error')); return }
      setMsgResult(bi(`✅ Envoyé à ${d.sent_count} inscrit(s)`, `✅ Sent to ${d.sent_count} attendee(s)`))
      setMessageText('')
      setTimeout(() => { setMessaging(false); setMsgResult(null) }, 2000)
    } finally { setSendingMsg(false) }
  }

  // Empty state. This section is now reachable by EVERY logged-in user, not
  // just people who have already organized something, so it has to read as
  // an invitation rather than as a report of an empty list.
  if (events.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-8 text-center">
        <div className="text-4xl mb-3">🎉</div>
        <h3 className="font-bold text-ink-primary mb-1">
          {bi('Organisez votre premier événement', 'Host your first event')}
        </h3>
        <p className="text-sm text-ink-secondary max-w-xs mx-auto">
          {bi(
            'Publiez un événement, vendez des billets et suivez vos inscrits — le tout depuis votre compte.',
            'Publish an event, sell tickets and track attendees — all from your account.',
          )}
        </p>
        <Link
          href="/events/submit"
          className="mt-5 inline-block bg-brand hover:bg-brand-dark text-white text-sm font-semibold px-5 py-2.5 rounded-full transition-colors"
        >
          📢 {bi('Créer un événement', 'Create an event')}
        </Link>
      </div>
    )
  }

  if (selected) {
    const dateStr = formatEventDates(selected, locale, 'message')
    return (
      <div>
        <button
          onClick={() => setSelectedId(null)}
          className="text-xs text-brand hover:text-brand-dark font-semibold mb-3"
        >
          ← {bi('Retour à mes événements', 'Back to my events')}
        </button>
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
          <p className="font-bold text-ink-primary">{selected.title}</p>
          <p className="text-xs text-ink-tertiary mt-0.5">{dateStr}{selected.venue ? ` · ${selected.venue}` : ''}</p>
          {selected.reservations_count === 0 && Number(selected.revenue) === 0 ? (
            <p className="text-sm text-ink-tertiary mt-3">{bi('Pas encore de réservation.', 'No bookings yet.')}</p>
          ) : (
          <div className={`grid ${Number(selected.revenue) > 0 ? 'grid-cols-3' : 'grid-cols-2'} gap-3 mt-3 text-center`}>
            <div>
              <p className="text-xs text-ink-tertiary">{bi('Réservations', 'Reservations')}</p>
              <p className="text-lg font-bold text-ink-primary">{selected.reservations_count}</p>
            </div>
            <div>
              <p className="text-xs text-ink-tertiary">{bi('Places', 'Tickets')}</p>
              <p className="text-lg font-bold text-ink-primary">
                {selected.tickets_count}{selected.max_tickets && selected.max_tickets > 0 ? `/${selected.max_tickets}` : ''}
              </p>
            </div>
            {Number(selected.revenue) > 0 && (
              <div>
                <p className="text-xs text-ink-tertiary">{bi('Recettes brutes', 'Gross')}</p>
                <p className="text-lg font-bold text-brand">{formatFCFA(Number(selected.revenue))}</p>
              </div>
            )}
          </div>
          )}
          {/* Commission breakdown — only when there's actual revenue to split.
              The 10% line is informational; the organizer's payout is the
              net figure. */}
          {selected.revenue > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div className="bg-surface-muted rounded-xl p-2 text-center">
                <p className="text-ink-tertiary">📊 {bi('Commission (10%)', 'Commission (10%)')}</p>
                <p className="font-semibold text-ink-primary">{formatFCFA(Number(selected.commission))}</p>
              </div>
              <div className="bg-brand-light rounded-xl p-2 text-center">
                <p className="text-brand-dark">💵 {bi('Net', 'Net')}</p>
                <p className="font-bold text-brand-darker">{formatFCFA(Number(selected.net_revenue))}</p>
              </div>
            </div>
          )}
        </div>

        {savedBanner && (
          <div className="bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-2xl px-4 py-2.5 text-sm font-semibold mb-4">
            {savedBanner}
          </div>
        )}

        {/* Organizer actions — edit details (notifies attendees on significant
            changes) and message everyone who reserved. */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={openEdit}
            className="flex-1 text-sm font-semibold px-3 py-2.5 rounded-xl border border-brand text-brand bg-white hover:bg-brand-light transition-colors"
          >
            ✏️ {bi('Modifier', 'Edit')}
          </button>
          <button
            onClick={() => { setMessageText(''); setMsgResult(null); setMessaging(true) }}
            className="flex-1 text-sm font-semibold px-3 py-2.5 rounded-xl bg-brand text-white hover:bg-brand-dark transition-colors"
          >
            📨 {bi('Message aux inscrits', 'Message attendees')}
          </button>
        </div>

        {/* Ticket tiers panel — self-contained CRUD for the event's
            tiered pricing. Renders empty state when the event still
            uses the legacy single price. */}
        <EventTiersPanel eventId={selected.id} multiDay={selectedDayCount > 1} onTiersLoaded={onTiersLoaded} />

        {/* Promo codes — organizer creates event-scoped vouchers. */}
        <EventVouchersPanel eventId={selected.id} />

        {/* Event-level controls — reservations open/close, manual approval
            toggle, capacity bump. Each PATCH refreshes the parent so the
            stats above stay live. */}
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-4 space-y-3">
          <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
            ⚙️ {bi('Paramètres', 'Settings')}
          </p>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-primary">
                {selected.reservations_open === false
                  ? bi('🔒 Réservations fermées', '🔒 Reservations closed')
                  : bi('🔓 Réservations ouvertes', '🔓 Reservations open')}
              </p>
            </div>
            <button
              onClick={toggleReservationsOpen}
              disabled={savingSettings}
              className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors disabled:opacity-50 ${
                selected.reservations_open === false
                  ? 'bg-brand text-white hover:bg-brand-dark'
                  : 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100'
              }`}
            >
              {selected.reservations_open === false
                ? bi('🔓 Ouvrir', '🔓 Open')
                : bi('🔒 Fermer', '🔒 Close')}
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 pt-3 border-t border-divider">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-primary">
                📋 {bi('Approbation manuelle', 'Manual approval')}
              </p>
              <p className="text-xs text-ink-tertiary mt-0.5">
                {selected.requires_confirmation
                  ? bi('Chaque réservation reste en attente.', 'Each reservation stays pending.')
                  : bi('Les réservations sont confirmées automatiquement.', 'Reservations are auto-confirmed.')}
              </p>
            </div>
            <button
              onClick={toggleRequiresConfirmation}
              disabled={savingSettings}
              className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors disabled:opacity-50 ${
                selected.requires_confirmation ? 'bg-brand text-white hover:bg-brand-dark' : 'bg-surface-muted text-ink-secondary hover:bg-divider'
              }`}
            >
              {selected.requires_confirmation
                ? bi('Désactiver', 'Disable')
                : bi('Activer', 'Enable')}
            </button>
          </div>
          <div className="pt-3 border-t border-divider">
            <p className="text-sm font-semibold text-ink-primary mb-1.5">
              🎟 {selectedDayCount > 1 ? bi('Places par jour', 'Seats per day') : bi('Capacité', 'Capacity')}
            </p>
            {selectedHasTiers ? (
              <p className="text-sm text-ink-primary">
                {selectedPerDay > 0 ? selectedPerDay : bi('Illimité', 'Unlimited')}
                <span className="text-xs text-ink-tertiary"> · {bi('somme des tarifs (max par jour)', "sum of the tiers' max per day")}</span>
              </p>
            ) : (
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={capacityDraft}
                onChange={e => setCapacityDraft(e.target.value)}
                placeholder={String(selected.max_tickets ?? 0)}
                className="flex-1 bg-surface-muted border border-divider rounded-xl px-3 py-1.5 text-sm"
              />
              <button
                onClick={saveCapacity}
                disabled={savingSettings || !capacityDraft.trim()}
                className="text-xs px-3 py-1.5 rounded-full font-semibold bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
              >
                💾 {bi('Mettre à jour', 'Update')}
              </button>
            </div>
            )}
            {!selectedHasTiers && (
              <p className="text-xs text-ink-tertiary mt-1">
                {bi('0 = illimité.', '0 = unlimited.')} {bi('Actuel:', 'Current:')} {selected.max_tickets ?? 0}
              </p>
            )}
            {capacityTotalLine(selectedDayCount, selectedPerDay, locale) && (
              <p className="text-xs text-ink-tertiary mt-1">{capacityTotalLine(selectedDayCount, selectedPerDay, locale)}</p>
            )}
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 bg-surface-muted p-1 rounded-xl w-fit mb-3 overflow-x-auto">
          {(['all', 'pending', 'confirmed', 'attended'] as const).map(f => (
            <button
              key={f}
              onClick={() => setResvFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                resvFilter === f ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
              }`}
            >
              {f === 'all' ? bi('Tous', 'All')
                : f === 'pending' ? bi('En attente', 'Pending')
                : f === 'confirmed' ? bi('Confirmées', 'Confirmed')
                : bi('Présents', 'Attended')}
            </button>
          ))}
        </div>

        {loadingResv ? (
          <div className="text-center py-12 text-ink-tertiary">…</div>
        ) : reservations.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm p-6 text-center text-sm text-ink-tertiary">
            {bi('Aucune réservation pour le moment.', 'No reservations yet.')}
          </div>
        ) : (
          <div className="space-y-2">
            {reservations.filter(r =>
              resvFilter === 'all'      ? true
              : resvFilter === 'pending'  ? r.reservation_status === 'pending'
              : resvFilter === 'confirmed' ? r.reservation_status === 'confirmed'
              : r.reservation_status === 'attended'
            ).map(r => {
              const wa = `https://wa.me/${r.customer_phone.replace(/[^\d]/g, '')}`
              const pillStatus =
                r.reservation_status === 'cancelled' ? { cls: 'bg-rose-50 text-rose-700 border border-rose-200',     label: '❌ ' + bi('Annulée',   'Cancelled') }
                : r.reservation_status === 'rejected' ? { cls: 'bg-rose-50 text-rose-700 border border-rose-200',     label: '❌ ' + bi('Refusée',   'Rejected') }
                : r.reservation_status === 'attended' ? { cls: 'bg-blue-50 text-blue-700 border border-blue-200',     label: '🎉 ' + bi('Présent',   'Attended') }
                : r.reservation_status === 'pending'  ? { cls: 'bg-amber-50 text-amber-700 border border-amber-200', label: '⏳ ' + bi('En attente', 'Pending') }
                : { cls: 'bg-brand-light text-brand-darker', label: '✅ ' + bi('Confirmée', 'Confirmed') }
              const pillPay =
                r.payment_status === 'paid'    ? { cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200', label: '💰 ' + bi('Payé', 'Paid') }
                : r.payment_status === 'pending' ? { cls: 'bg-amber-50 text-amber-700 border border-amber-200',      label: '⏳ ' + bi('En attente', 'Pending') }
                : r.payment_status === 'failed'  ? { cls: 'bg-rose-50 text-rose-700 border border-rose-200',         label: '❌ ' + bi('Échec', 'Failed') }
                : null
              return (
                <div key={r.id} className="bg-white rounded-2xl shadow-sm p-3">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0">
                      {/* The code is what the organizer checks people in
                          with, so it always renders — legacy rows without a
                          stored code fall back to the id suffix rather than
                          showing nothing. */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] font-bold font-mono px-2 py-0.5 rounded bg-ink-primary text-white tracking-wider">
                          #{r.reservation_code ?? r.id.replace(/-/g, '').slice(-4).toUpperCase()}
                        </span>
                        <p className="font-semibold text-ink-primary text-sm truncate">{r.customer_name}</p>
                      </div>
                      <a href={wa} target="_blank" rel="noopener noreferrer"
                         className="text-xs text-brand-darker font-mono hover:underline">
                        📱 {r.customer_phone}
                      </a>
                      <p className="text-xs text-ink-tertiary mt-0.5">
                        {selected && isMultiDay(selected) && r.event_date && (
                          <>📅 {formatEventDay(r.event_date, locale, 'compact')} · </>
                        )}
                        🎟 {r.quantity}{r.total_price > 0 && <> · {formatFCFA(Number(r.total_price))}</>}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1 items-end flex-shrink-0">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${pillStatus.cls}`}>
                        {pillStatus.label}
                      </span>
                      {pillPay && (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${pillPay.cls}`}>
                          {pillPay.label}
                        </span>
                      )}
                    </div>
                  </div>
                  {r.reservation_status === 'pending' && (
                    <div className="flex items-center gap-2 pt-2 border-t border-divider">
                      <button
                        onClick={() => confirmRes(r.id)}
                        disabled={acting === r.id}
                        className="text-xs px-3 py-1.5 rounded-full font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        ✅ {bi('Confirmer', 'Confirm')}
                      </button>
                      <button
                        onClick={() => rejectRes(r.id)}
                        disabled={acting === r.id}
                        className="text-xs px-3 py-1.5 rounded-full font-semibold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-50"
                      >
                        ❌ {bi('Rejeter', 'Reject')}
                      </button>
                    </div>
                  )}
                  {r.reservation_status === 'confirmed' && (
                    <div className="flex items-center gap-2 pt-2 border-t border-divider">
                      <button
                        onClick={() => attend(r.id)}
                        disabled={acting === r.id}
                        className="text-xs px-3 py-1.5 rounded-full font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        ✅ {bi('Présent', 'Attended')}
                      </button>
                      <button
                        onClick={() => cancel(r.id)}
                        disabled={acting === r.id}
                        className="text-xs px-3 py-1.5 rounded-full font-semibold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-50"
                      >
                        ❌ {bi('Annuler', 'Cancel')}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ── Cancel reservation confirmation ── */}
        {cancelTarget && (
          <ConfirmModal
            title={bi(
              `Annuler la réservation #${cancelRow?.reservation_code ?? cancelTarget.slice(-4).toUpperCase()} ?`,
              `Cancel reservation #${cancelRow?.reservation_code ?? cancelTarget.slice(-4).toUpperCase()}?`,
            )}
            confirmLabel={bi('Oui, annuler', 'Yes, cancel')}
            confirmClass="bg-danger hover:bg-danger text-white"
            cancelLabel={bi('Garder', 'Keep it')}
            busy={acting === cancelTarget}
            error={cancelError}
            onCancel={() => setCancelTarget(null)}
            onConfirm={doCancel}
          >
            {cancelRow?.payment_status === 'paid' && (
              <p className="text-sm text-ink-secondary">
                💰 {bi('Ce billet est payé : le client devra être remboursé.', 'This ticket is paid: the customer will need a refund.')}
              </p>
            )}
          </ConfirmModal>
        )}

        {/* ── Edit event modal ── */}
        {editing && editForm && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-0 sm:px-4" onClick={() => !savingEdit && setEditing(false)}>
            <div className="bg-white rounded-t-3xl sm:rounded-2xl shadow-card w-full sm:max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-ink-primary">✏️ {bi('Modifier l\'événement', 'Edit event')}</h3>
                  <button onClick={() => !savingEdit && setEditing(false)} className="text-ink-tertiary hover:text-ink-primary text-xl leading-none">×</button>
                </div>

                <label className="block">
                  <span className="text-xs font-semibold text-ink-secondary">{bi('Titre', 'Title')}</span>
                  <input value={editForm.title} onChange={e => setEdit('title', e.target.value)}
                    className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                </label>

                <label className="block">
                  <span className="text-xs font-semibold text-ink-secondary">{bi('Description', 'Description')}</span>
                  <textarea value={editForm.description} onChange={e => setEdit('description', e.target.value)} rows={3}
                    className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm resize-none" />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Date de début', 'Start date')}</span>
                    <input type="date" value={editForm.date} onChange={e => setEdit('date', e.target.value)}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Heure de début', 'Start time')}</span>
                    <input type="time" value={editForm.time} onChange={e => setEdit('time', e.target.value)}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                </div>

                {/* End — optional; blank = same day as the start */}
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Date de fin (optionnel)', 'End date (optional)')}</span>
                    <input type="date" min={editForm.date || undefined} value={editForm.end_date} onChange={e => setEdit('end_date', e.target.value)}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Heure de fin (optionnel)', 'End time (optional)')}</span>
                    <input type="time" value={editForm.end_time} onChange={e => setEdit('end_time', e.target.value)}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Lieu', 'Venue')}</span>
                    <input value={editForm.venue} onChange={e => setEdit('venue', e.target.value)}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Quartier', 'Neighborhood')}</span>
                    <input value={editForm.neighborhood} onChange={e => setEdit('neighborhood', e.target.value)}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                </div>

                <label className="block">
                  <span className="text-xs font-semibold text-ink-secondary">{bi('Catégorie', 'Category')}</span>
                  <select value={editForm.category} onChange={e => setEdit('category', e.target.value)}
                    className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm">
                    <option value="">—</option>
                    {EVENT_EDIT_CATEGORIES.map(c => <option key={c} value={c}>{categoryLabel(c, locale)}</option>)}
                  </select>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Prix billet (FCFA)', 'Ticket price (FCFA)')}</span>
                    <input type="number" min={0} value={editForm.ticket_price} onChange={e => setEdit('ticket_price', e.target.value)}
                      placeholder={bi('0 = gratuit', '0 = free')}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">
                      {editDayCount > 1 ? bi('Places par jour', 'Seats per day') : bi('Places max', 'Max tickets')}
                    </span>
                    {selectedHasTiers ? (
                      <span className="mt-1 block w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm text-ink-secondary">
                        {selectedPerDay > 0 ? selectedPerDay : bi('Illimité', 'Unlimited')}
                        <span className="block text-[10px] text-ink-tertiary">{bi('Somme des tarifs', 'Sum of the tiers')}</span>
                      </span>
                    ) : (
                      <input type="number" min={0} value={editForm.max_tickets} onChange={e => setEdit('max_tickets', e.target.value)}
                        placeholder={bi('0 = illimité', '0 = unlimited')}
                        className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                    )}
                    {capacityTotalLine(editDayCount, selectedHasTiers ? selectedPerDay : Number(editForm.max_tickets || 0), locale) && (
                      <span className="block text-[11px] text-ink-tertiary mt-1">
                        {capacityTotalLine(editDayCount, selectedHasTiers ? selectedPerDay : Number(editForm.max_tickets || 0), locale)}
                      </span>
                    )}
                  </label>
                </div>

                {/* Payment mode — only meaningful for paid events. */}
                {Number(editForm.ticket_price || 0) > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Paiement', 'Payment')}</span>
                    <div className="inline-flex rounded-xl bg-surface-muted p-0.5 w-full">
                      {([
                        ['reservation_only', bi('📋 Réservation', '📋 Reservation')],
                        ['payment_only',     bi('💰 Paiement', '💰 Payment')],
                        ['both',             bi('💰📋 Les deux', '💰📋 Both')],
                      ] as [PaymentMode, string][]).map(([value, label]) => (
                        <button key={value} type="button" onClick={() => setEdit('payment_mode', value)}
                          className={`flex-1 text-xs font-semibold px-2 py-1.5 rounded-lg transition-colors ${
                            editForm.payment_mode === value ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {canPayOnline(editForm.payment_mode) && (
                      <label className="flex items-center gap-2 text-sm text-ink-primary cursor-pointer">
                        <input type="checkbox" checked={editForm.whatsapp_payment_enabled}
                          onChange={e => setEdit('whatsapp_payment_enabled', e.target.checked)}
                          className="w-4 h-4 rounded border-divider text-brand" />
                        💬💰 {bi('Autoriser le paiement via WhatsApp', 'Allow payment via WhatsApp')}
                      </label>
                    )}
                  </div>
                )}

                <label className="block">
                  <span className="text-xs font-semibold text-ink-secondary">{bi('Affiche de l\'événement', 'Event poster')}</span>
                  <span className="block text-[11px] text-ink-tertiary">{bi('Format conseillé : 1080 × 1350 px (portrait 4:5).', 'Recommended: 1080 × 1350 px (portrait 4:5).')}</span>
                  <div className="mt-1 flex items-center gap-3">
                    {editForm.cover_photo && (
                      <Image src={editForm.cover_photo} alt="" width={56} height={70} className="w-14 h-[70px] rounded-xl object-cover" />
                    )}
                    <input type="file" accept="image/*" onChange={handleEditPhoto} className="text-xs flex-1" />
                    {editPhotoUploading && <span className="text-xs text-ink-tertiary">…</span>}
                  </div>
                </label>

                <label className="block">
                  <span className="text-xs font-semibold text-ink-secondary">{bi('Autre numéro pour les notifications (facultatif)', 'Extra notification number (optional)')}</span>
                  <input value={editForm.notify_phone} onChange={e => setEdit('notify_phone', e.target.value)} inputMode="tel" placeholder="6 70 00 00 00"
                    className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  <span className="block text-[11px] text-ink-tertiary mt-1">{bi('En plus du numéro de votre compte.', 'In addition to your account number.')}</span>
                </label>

                {editError && <p className="text-sm text-rose-600 font-medium">{editError}</p>}

                <div className="flex gap-2 pt-1">
                  <button onClick={() => setEditing(false)} disabled={savingEdit}
                    className="flex-1 text-sm font-semibold py-2.5 rounded-xl bg-surface-muted text-ink-secondary hover:bg-divider disabled:opacity-50">
                    {bi('Annuler', 'Cancel')}
                  </button>
                  <button onClick={saveEdit} disabled={savingEdit || editPhotoUploading}
                    className="flex-1 text-sm font-semibold py-2.5 rounded-xl bg-brand text-white hover:bg-brand-dark disabled:opacity-50">
                    {savingEdit ? '…' : bi('💾 Enregistrer', '💾 Save')}
                  </button>
                </div>
                <p className="text-[11px] text-ink-tertiary text-center">
                  {bi('Les inscrits sont notifiés si la date, l\'heure, le lieu ou le prix change.',
                     'Attendees are notified if the date, time, venue or price changes.')}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── Message attendees modal ── */}
        {messaging && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-0 sm:px-4" onClick={() => !sendingMsg && setMessaging(false)}>
            <div className="bg-white rounded-t-3xl sm:rounded-2xl shadow-card w-full sm:max-w-md" onClick={e => e.stopPropagation()}>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-ink-primary">📨 {bi('Message aux inscrits', 'Message attendees')}</h3>
                  <button onClick={() => !sendingMsg && setMessaging(false)} className="text-ink-tertiary hover:text-ink-primary text-xl leading-none">×</button>
                </div>
                <p className="text-sm text-ink-tertiary">
                  {bi(
                    `Ce message sera envoyé à ${selected.reservations_count} personne(s) inscrite(s).`,
                    `This message will be sent to ${selected.reservations_count} registered attendee(s).`,
                  )}
                </p>
                <textarea
                  value={messageText}
                  onChange={e => setMessageText(e.target.value.slice(0, 1000))}
                  rows={5}
                  placeholder={bi('Votre message…', 'Your message…')}
                  className="w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm resize-none"
                />
                <div className="flex items-center justify-between text-xs text-ink-tertiary">
                  <span>{messageText.length}/1000</span>
                  <span>{bi('Max 2 messages/jour', 'Max 2 messages/day')}</span>
                </div>
                {msgResult && <p className="text-sm font-medium text-ink-primary">{msgResult}</p>}
                <div className="flex gap-2">
                  <button onClick={() => setMessaging(false)} disabled={sendingMsg}
                    className="flex-1 text-sm font-semibold py-2.5 rounded-xl bg-surface-muted text-ink-secondary hover:bg-divider disabled:opacity-50">
                    {bi('Annuler', 'Cancel')}
                  </button>
                  <button onClick={sendMessage} disabled={sendingMsg || !messageText.trim()}
                    className="flex-1 text-sm font-semibold py-2.5 rounded-xl bg-brand text-white hover:bg-brand-dark disabled:opacity-50">
                    {sendingMsg ? '…' : bi('Envoyer', 'Send')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-bold text-ink-primary">🎉 {bi('Mes événements', 'My events')}</h2>
        {trust && (
          trust.event_auto_approve ? (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              ✅ {bi('Organisateur vérifié', 'Verified organiser')}
            </span>
          ) : trust.events_approved_count > 0 ? (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
              {trust.events_approved_count}/3 {bi('événements approuvés', 'events approved')}
            </span>
          ) : null
        )}
      </div>
      <Link
        href="/events/submit"
        className="block w-full text-center bg-brand hover:bg-brand-dark text-white text-sm font-semibold px-5 py-3 rounded-full transition-colors"
      >
        📢 {bi('Publier un événement', 'Publish new event')}
      </Link>

      {events.map(e => {
        const whenStr = formatEventWhen(e, locale, 'card')
        const ticketPrice = Number(e.ticket_price ?? 0)
        return (
          <button
            key={e.id}
            onClick={() => openEvent(e.id)}
            className="w-full text-left bg-white rounded-2xl shadow-sm p-3 hover:bg-surface-muted transition-colors"
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <p className="font-semibold text-ink-primary text-sm truncate">{e.title}</p>
                <p className="text-xs text-ink-tertiary mt-0.5">
                  {whenStr}{e.venue ? ` · ${e.venue}` : ''}
                </p>
              </div>
              {!e.is_active && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap">
                  ⏳ {bi('En attente d\'approbation', 'Pending approval')}
                </span>
              )}
              {e.event_status === 'cancelled' && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 whitespace-nowrap">
                  ❌ {bi('Annulé', 'Cancelled')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 text-xs text-ink-secondary">
              {e.reservations_count === 0 ? (
                <span className="text-ink-tertiary">{bi('Pas encore de réservation', 'No bookings yet')}</span>
              ) : (
                <>
                  <span>🎟 {e.tickets_count}{e.max_tickets && e.max_tickets > 0 ? `/${e.max_tickets}` : ''} {bi('places', 'tickets')}</span>
                  <span>📋 {e.reservations_count} {bi('réservations', 'reservations')}</span>
                </>
              )}
              {ticketPrice > 0 && Number(e.revenue) > 0 && (
                <span className="text-brand font-semibold">
                  💰 {formatFCFA(Number(e.revenue))}
                </span>
              )}
            </div>
          </button>
        )
      })}

      <OrganizerSubscribersCard events={events} />
    </div>
  )
}

// "Who can I reach?" summary under the organizer's event list. Counts the
// subscribers matching the cities and categories the organizer actually
// publishes in, using the same /api/broadcasts/preview endpoint the paid
// broadcast composer uses — so this number and the one shown at send time
// come from one source. Read-only: it never commits anything.
function OrganizerSubscribersCard({ events }: { events: MyEventsPanelEvent[] }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [rows, setRows] = useState<Array<{ city: string; recipients: number }>>([])
  const [loading, setLoading] = useState(true)

  // Distinct cities the organizer publishes in, and the categories they use.
  // Both are derived from their own events, so the count reflects the
  // audience for the kind of events they actually run.
  const cities = Array.from(new Set(events.map(e => e.city).filter(Boolean))) as string[]
  const categories = Array.from(new Set(events.map(e => e.category).filter(Boolean))) as string[]
  const cityKey = cities.join('|')
  const catKey  = categories.join('|')

  useEffect(() => {
    const cityList = cityKey ? cityKey.split('|') : []
    const catList  = catKey ? catKey.split('|') : []
    if (cityList.length === 0) { setRows([]); setLoading(false); return }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        // One request per city — organizers publish in one or two, and the
        // cap keeps a pathological account from fanning out.
        const results = await Promise.all(
          cityList.slice(0, 4).map(async city => {
            const res = await fetch('/api/broadcasts/preview', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ target_city: city, target_categories: catList.length ? catList : null }),
            })
            const d = await res.json()
            return { city, recipients: Number(d?.recipients ?? 0) }
          }),
        )
        if (!cancelled) setRows(results)
      } catch { if (!cancelled) setRows([]) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [cityKey, catKey])

  if (!loading && rows.length === 0) return null

  const total = rows.reduce((n, r) => n + r.recipients, 0)
  // No subscriber yet → no "0 abonné" card.
  if (!loading && total === 0) return null

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4">
      <h3 className="text-sm font-bold text-ink-primary">
        🔔 {bi('Abonnements', 'Subscriptions')}
      </h3>
      <p className="text-xs text-ink-tertiary mt-0.5">
        {bi(
          'Abonnés aux catégories de vos événements',
          'Subscribers to your event categories',
        )}
      </p>
      {loading ? (
        <p className="text-sm text-ink-tertiary mt-3">…</p>
      ) : (
        <>
          <p className="text-2xl font-bold text-ink-primary mt-3">
            {total.toLocaleString()}
            <span className="text-sm font-semibold text-ink-secondary ml-1.5">
              {bi('abonné(s)', 'subscriber(s)')}
            </span>
          </p>
          <div className="mt-2 space-y-1">
            {rows.map(r => (
              <p key={r.city} className="text-xs text-ink-secondary flex justify-between gap-3">
                <span className="truncate">📍 {r.city}</span>
                <span className="font-semibold text-ink-primary">{r.recipients.toLocaleString()}</span>
              </p>
            ))}
          </div>
          {categories.length > 0 && (
            <p className="text-[11px] text-ink-tertiary mt-2 truncate">
              {categories.map(c => categoryLabel(c, locale)).join(' · ')}
            </p>
          )}
        </>
      )}
    </div>
  )
}

