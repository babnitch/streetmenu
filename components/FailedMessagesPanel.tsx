'use client'

// Admin → 📨 Messages: paid customers who never got their confirmation, and
// the WhatsApp retry queue (lib/messageRetry.ts). Backed by
// GET /api/admin/messages/failed.

import { useCallback, useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { formatEventDay } from '@/lib/eventDate'

interface Unconfirmed {
  kind:            'order' | 'reservation'
  id:              string
  ref:             string
  customer_name:   string | null
  customer_phone:  string | null
  total_price:     number | null
  created_at:      string
  last_status:     string | null
  last_error_code: string | null
  last_attempt_at: string | null
  retry_status:    string | null
  retry_next_at:   string | null
}

interface OversoldRow {
  reservation_id:   string
  flagged_at:       string
  event_title:      string | null
  event_date:       string | null
  tier_name:        string | null
  quantity:         number | null
  customer_name:    string | null
  customer_phone:   string | null
  reservation_code: string | null
}

interface QueueRow {
  id:              string
  to_number:       string
  context:         string | null
  status:          'pending' | 'sending' | 'gave_up'
  attempts:        number
  next_attempt_at: string
  last_error_code: string | null
  created_at:      string
}

function fmt(iso: string | null, locale: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export default function FailedMessagesPanel() {
  const bi = useBi()
  const locale = bi('fr', 'en')
  const [unconfirmed, setUnconfirmed] = useState<Unconfirmed[]>([])
  const [queue, setQueue]             = useState<QueueRow[] | null>(null)
  const [oversold, setOversold]       = useState<OversoldRow[]>([])
  const [days, setDays]               = useState(7)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch('/api/admin/messages/failed', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Erreur de chargement / Failed to load')
      } else {
        setUnconfirmed(data.unconfirmed ?? [])
        setQueue(data.queueAvailable ? (data.queue ?? []) : null)
        setOversold(data.oversold ?? [])
        setDays(data.windowDays ?? 7)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const retryLabel = (s: string | null) =>
    s === 'pending' ? bi('🔁 nouvel essai prévu', '🔁 retry scheduled')
      : s === 'sending' ? bi('🔁 envoi en cours', '🔁 sending')
      : s === 'gave_up' ? bi('⛔ abandonné', '⛔ gave up')
      : s === 'sent' ? bi('🔁 renvoyé', '🔁 resent')
      : bi('pas de nouvel essai', 'no retry')

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-divider p-4 mb-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="font-bold text-ink-primary text-sm">
          💳 {bi(`Payé, sans confirmation reçue (${days} j)`, `Paid, no confirmation received (${days}d)`)}
        </h2>
        <button onClick={load} disabled={loading}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-divider hover:bg-surface-muted disabled:opacity-50">
          {loading ? '…' : bi('Actualiser', 'Refresh')}
        </button>
      </div>

      {error && <p className="text-xs text-danger mb-3">{error}</p>}

      {!loading && !error && unconfirmed.length === 0 && (
        <p className="text-xs text-ink-tertiary mb-3">
          ✅ {bi('Tous les clients payés ont reçu leur confirmation.', 'Every paying customer got their confirmation.')}
        </p>
      )}

      {unconfirmed.length > 0 && (
        <ul className="divide-y divide-divider mb-4">
          {unconfirmed.map(u => (
            <li key={`${u.kind}-${u.id}`} className="py-2 text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold text-ink-primary">
                {u.kind === 'order' ? '🧾' : '🎟'} #{u.ref}
              </span>
              <span className="text-ink-secondary">{u.customer_name ?? '—'}</span>
              <span className="font-mono text-ink-secondary">{u.customer_phone}</span>
              <span className="text-ink-secondary">{Number(u.total_price ?? 0).toLocaleString()} FCFA</span>
              <span className="text-ink-tertiary">{fmt(u.created_at, locale)}</span>
              <span className={`px-2 py-0.5 rounded-full ${u.last_status ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>
                {u.last_status
                  ? `${u.last_status}${u.last_error_code ? ` · ${u.last_error_code}` : ''}`
                  : bi('aucun envoi', 'never sent')}
              </span>
              <span className="text-ink-tertiary">
                {retryLabel(u.retry_status)}{u.retry_status === 'pending' ? ` · ${fmt(u.retry_next_at, locale)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Only rendered when there is something to act on. */}
      {oversold.length > 0 && (
        <div className="mb-4">
          <h3 className="font-semibold text-amber-700 text-xs mb-1">
            ⚠️ {bi('Survente — billets payés au-delà de la capacité', 'Oversold — tickets paid beyond capacity')}
          </h3>
          <p className="text-[11px] text-ink-tertiary mb-2">
            {bi(
              'Paiement arrivé après expiration de la réservation : le client est confirmé. Prévenez l\'organisateur (place à libérer ou remboursement).',
              'Payment arrived after the hold expired: the customer is confirmed. Tell the organiser (make room or refund).',
            )}
          </p>
          <ul className="divide-y divide-divider">
            {oversold.map(o => (
              <li key={o.reservation_id} className="py-2 text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold text-ink-primary">🎟 #{o.reservation_code ?? o.reservation_id.slice(-4).toUpperCase()}</span>
                <span className="text-ink-secondary">{o.event_title ?? '—'}</span>
                {o.event_date && <span className="text-ink-secondary">{formatEventDay(o.event_date, locale === 'en' ? 'en' : 'fr', 'compact')}</span>}
                {o.tier_name && <span className="text-ink-secondary">{o.tier_name}</span>}
                <span className="text-ink-secondary">× {o.quantity ?? '?'}</span>
                <span className="text-ink-secondary">{o.customer_name ?? '—'}</span>
                <span className="font-mono text-ink-secondary">{o.customer_phone}</span>
                <span className="text-ink-tertiary">{fmt(o.flagged_at, locale)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="font-semibold text-ink-primary text-xs mb-2">
        🔁 {bi('File de renvoi WhatsApp', 'WhatsApp retry queue')}
      </h3>
      {queue === null ? (
        <p className="text-xs text-ink-tertiary">
          {bi('File indisponible — exécutez supabase-message-retry.sql.', 'Queue unavailable — run supabase-message-retry.sql.')}
        </p>
      ) : queue.length === 0 ? (
        <p className="text-xs text-ink-tertiary">{bi('Vide.', 'Empty.')}</p>
      ) : (
        <ul className="divide-y divide-divider">
          {queue.map(q => (
            <li key={q.id} className="py-2 text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-ink-secondary">{q.to_number}</span>
              <span className="text-ink-secondary">{q.context ?? '—'}</span>
              <span className="text-ink-tertiary">{bi('essais', 'attempts')}: {q.attempts}</span>
              <span className="text-ink-tertiary">{q.last_error_code ?? '—'}</span>
              <span className={q.status === 'gave_up' ? 'text-danger' : 'text-ink-secondary'}>
                {retryLabel(q.status)}{q.status === 'pending' ? ` · ${fmt(q.next_attempt_at, locale)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
