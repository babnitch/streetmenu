'use client'

// Message log viewer — the WhatsApp/SMS delivery log with real Twilio
// statuses. Used twice:
//   • admin → 📨 Messages   (full: stats + filters + pagination)
//   • admin → Accounts → expand a customer (scoped to that customer)
//
// Data comes from GET /api/admin/messages, which is admin/super_admin only.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useBi } from '@/lib/languageContext'

export interface MessageRow {
  id:                string
  twilio_sid:        string | null
  direction:         string
  channel:           'whatsapp' | 'sms'
  from_number:       string | null
  to_number:         string | null
  body:              string | null
  status:            string
  status_updated_at: string | null
  error_code:        string | null
  error_message:     string | null
  context:           string | null
  related_id:        string | null
  customer_id:       string | null
  cost:              number | null
  created_at:        string
}

interface Stats {
  today: number; week: number; month: number
  windowDays: number; windowTotal: number
  delivered: number; read: number; failed: number
  undelivered: number; queued: number; sent: number
  whatsappSent: number
  deliveryRate: number | null
  readRate:     number | null
  totalCost:    number
}

// Badge styling per status. Emoji + colour together — colour alone doesn't
// survive a screenshot pasted into WhatsApp, which is how this log usually
// gets shared.
const STATUS_STYLE: Record<string, { icon: string; fr: string; en: string; cls: string }> = {
  queued:      { icon: '📤', fr: 'En file',    en: 'Queued',      cls: 'bg-surface-muted text-ink-secondary' },
  sent:        { icon: '✈️', fr: 'Envoyé',     en: 'Sent',        cls: 'bg-blue-50 text-blue-700' },
  delivered:   { icon: '✅', fr: 'Livré',      en: 'Delivered',   cls: 'bg-green-50 text-green-700' },
  read:        { icon: '👁️', fr: 'Lu',         en: 'Read',        cls: 'bg-green-100 text-green-800 font-bold' },
  failed:      { icon: '❌', fr: 'Échoué',     en: 'Failed',      cls: 'bg-red-50 text-red-700' },
  undelivered: { icon: '⚠️', fr: 'Non livré',  en: 'Undelivered', cls: 'bg-amber-50 text-amber-700' },
}

const CONTEXT_LABELS: Record<string, [string, string]> = {
  verification_code:   ['Code de vérification', 'Verification code'],
  order_notification:  ['Commande',             'Order'],
  order_status_update: ['Statut commande',      'Order status'],
  payment_confirmation:['Paiement',             'Payment'],
  event_reservation:   ['Réservation',          'Reservation'],
  event_update:        ['Mise à jour événement','Event update'],
  broadcast:           ['Diffusion',            'Broadcast'],
  direct_message:      ['Message direct',       'Direct message'],
  subscription_alert:  ['Alerte abonnement',    'Subscription alert'],
  rating_prompt:       ['Demande d’avis',  'Rating prompt'],
  account_notice:      ['Avis de compte',       'Account notice'],
  team_invitation:     ['Invitation équipe',    'Team invitation'],
  bot_reply:           ['Réponse bot',          'Bot reply'],
}

// Which contexts point at something with a public page we can link to.
function relatedLink(context: string | null, relatedId: string | null): string | null {
  if (!relatedId) return null
  if (context === 'event_reservation' || context === 'event_update') return `/events/${relatedId}`
  if (context === 'team_invitation' || context === 'account_notice')  return `/restaurant/${relatedId}`
  return null
}

function fmtDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function fmtCost(cost: number | null): string {
  if (cost === null || cost === undefined) return '—'
  return `$${Number(cost).toFixed(5)}`
}

const SELECT_CLS =
  'border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white'

export default function MessageLogPanel({
  customerId,
  showStats = false,
  showFilters = false,
}: {
  /** Scope the log to one customer (matched on customer_id OR their phone). */
  customerId?: string
  showStats?: boolean
  showFilters?: boolean
}) {
  const bi = useBi()
  const locale = bi('fr', 'en')

  const [rows,     setRows]     = useState<MessageRow[]>([])
  const [stats,    setStats]    = useState<Stats | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [page,     setPage]     = useState(0)
  const [hasMore,  setHasMore]  = useState(false)
  const [total,    setTotal]    = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Filters
  const [status,  setStatus]  = useState('all')
  const [channel, setChannel] = useState('all')
  const [context, setContext] = useState('all')
  const [phone,   setPhone]   = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo,   setDateTo]   = useState('')

  // `phone` is debounced so typing a number doesn't fire a request per keystroke.
  const [phoneQuery, setPhoneQuery] = useState('')
  useEffect(() => {
    const id = setTimeout(() => { setPhoneQuery(phone); setPage(0) }, 350)
    return () => clearTimeout(id)
  }, [phone])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams()
    if (customerId) qs.set('customerId', customerId)
    if (status  !== 'all') qs.set('status', status)
    if (channel !== 'all') qs.set('channel', channel)
    if (context !== 'all') qs.set('context', context)
    if (phoneQuery) qs.set('phone', phoneQuery)
    if (dateFrom)   qs.set('from', dateFrom)
    if (dateTo)     qs.set('to', dateTo)
    if (page)       qs.set('page', String(page))
    if (!showStats) qs.set('stats', '0')

    try {
      const res  = await fetch(`/api/admin/messages?${qs.toString()}`, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Erreur de chargement / Failed to load')
        setRows([])
      } else {
        setRows(data.messages ?? [])
        setTotal(data.total ?? 0)
        setHasMore(!!data.hasMore)
        if (data.stats) setStats(data.stats)
      }
    } catch (e) {
      setError((e as Error).message)
      setRows([])
    }
    setLoading(false)
    // `bi` is deliberately NOT a dependency: useBi() returns a fresh closure
    // on every render, so including it would rebuild `load` each render and
    // the effect below would refetch forever.
  }, [customerId, status, channel, context, phoneQuery, dateFrom, dateTo, page, showStats])

  useEffect(() => { load() }, [load])

  // Any filter change resets to the first page — otherwise a narrow filter on
  // page 3 shows an empty list that looks like "no messages".
  useEffect(() => { setPage(0) }, [status, channel, context, dateFrom, dateTo])

  return (
    <div>
      {showStats && <StatsBar stats={stats} bi={bi} />}

      {showFilters && (
        <div className="flex flex-wrap gap-2 mb-4">
          <select value={status} onChange={e => setStatus(e.target.value)} className={SELECT_CLS}>
            <option value="all">{bi('Tous les statuts', 'All statuses')}</option>
            <option value="delivered">✅ {bi('Livré', 'Delivered')}</option>
            <option value="read">👁️ {bi('Lu', 'Read')}</option>
            <option value="failed">❌ {bi('Échoué', 'Failed')}</option>
            <option value="undelivered">⚠️ {bi('Non livré', 'Undelivered')}</option>
            <option value="sent">✈️ {bi('Envoyé', 'Sent')}</option>
            <option value="queued">📤 {bi('En file', 'Queued')}</option>
          </select>

          <select value={channel} onChange={e => setChannel(e.target.value)} className={SELECT_CLS}>
            <option value="all">{bi('Tous les canaux', 'All channels')}</option>
            <option value="whatsapp">💬 WhatsApp</option>
            <option value="sms">📱 SMS</option>
          </select>

          <select value={context} onChange={e => setContext(e.target.value)} className={SELECT_CLS}>
            <option value="all">{bi('Tous les types', 'All types')}</option>
            <option value="verification">{bi('Vérification', 'Verification')}</option>
            <option value="orders">{bi('Commandes', 'Orders')}</option>
            <option value="events">{bi('Événements', 'Events')}</option>
            <option value="broadcasts">{bi('Diffusions', 'Broadcasts')}</option>
            <option value="bot_reply">{bi('Réponses bot', 'Bot replies')}</option>
          </select>

          <input
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder={bi('Rechercher un numéro…', 'Search a number…')}
            className={`${SELECT_CLS} flex-1 min-w-[180px]`}
          />

          <div className="flex items-center gap-1">
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className={SELECT_CLS} aria-label={bi('Date de début', 'Start date')} />
            <span className="text-ink-tertiary text-sm">→</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className={SELECT_CLS} aria-label={bi('Date de fin', 'End date')} />
          </div>

          {(status !== 'all' || channel !== 'all' || context !== 'all' || phone || dateFrom || dateTo) && (
            <button
              onClick={() => { setStatus('all'); setChannel('all'); setContext('all'); setPhone(''); setDateFrom(''); setDateTo('') }}
              className="text-sm text-ink-secondary hover:text-ink-primary px-3 py-2 rounded-xl hover:bg-surface-muted"
            >
              {bi('Réinitialiser', 'Reset')}
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-10 text-ink-tertiary">
          <div className="text-3xl mb-2 animate-pulse">📨</div>
          <p className="text-sm">{bi('Chargement…', 'Loading…')}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-10 text-ink-tertiary">
          <div className="text-3xl mb-2">📭</div>
          <p className="text-sm">{bi('Aucun message', 'No messages')}</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-2xl border border-divider overflow-hidden">
            {rows.map(m => (
              <MessageRowItem
                key={m.id}
                m={m}
                locale={locale}
                bi={bi}
                expanded={expanded === m.id}
                onToggle={() => setExpanded(expanded === m.id ? null : m.id)}
              />
            ))}
          </div>

          <div className="flex items-center justify-between mt-3">
            <p className="text-xs text-ink-tertiary">
              {bi(`${total} message(s)`, `${total} message(s)`)}
            </p>
            {(page > 0 || hasMore) && (
              <div className="flex gap-2">
                <button
                  disabled={page === 0}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  className="text-sm px-3 py-1.5 rounded-lg border border-divider disabled:opacity-40 hover:bg-surface-muted"
                >
                  ← {bi('Précédent', 'Previous')}
                </button>
                <button
                  disabled={!hasMore}
                  onClick={() => setPage(p => p + 1)}
                  className="text-sm px-3 py-1.5 rounded-lg border border-divider disabled:opacity-40 hover:bg-surface-muted"
                >
                  {bi('Suivant', 'Next')} →
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────

function MessageRowItem({
  m, locale, bi, expanded, onToggle,
}: {
  m: MessageRow
  locale: string
  bi: (fr: string, en: string) => string
  expanded: boolean
  onToggle: () => void
}) {
  const style   = STATUS_STYLE[m.status] ?? STATUS_STYLE.queued
  const ctxPair = m.context ? CONTEXT_LABELS[m.context] : null
  const ctxText = ctxPair ? bi(ctxPair[0], ctxPair[1]) : (m.context ?? '—')
  const preview = (m.body ?? '').replace(/\s+/g, ' ').slice(0, 50)
  const link    = relatedLink(m.context, m.related_id)

  return (
    <div className="border-b border-divider last:border-0">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 hover:bg-surface-muted transition-colors flex items-start gap-3"
      >
        <span className="text-lg leading-none pt-0.5" aria-hidden>
          {m.channel === 'whatsapp' ? '💬' : '📱'}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-sm text-ink-primary">{m.to_number || '—'}</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full ${style.cls}`}>
              {style.icon} {bi(style.fr, style.en)}
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-muted text-ink-secondary">
              {ctxText}
            </span>
          </div>
          <p className="text-sm text-ink-secondary mt-1 truncate">
            {preview}{(m.body ?? '').length > 50 ? '…' : ''}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-ink-tertiary whitespace-nowrap">{fmtDateTime(m.created_at, locale)}</p>
          <p className="text-xs text-ink-tertiary mt-0.5">{expanded ? '▲' : '▼'}</p>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 bg-surface-muted border-t border-divider space-y-3">
          <div className="pt-3">
            <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1">
              {bi('Message complet', 'Full message')}
            </p>
            <pre className="text-sm text-ink-primary whitespace-pre-wrap break-words font-sans bg-white rounded-xl border border-divider p-3">
              {m.body || '—'}
            </pre>
          </div>

          <Timeline m={m} locale={locale} bi={bi} />

          {(m.error_code || m.error_message) && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3">
              <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">
                {bi('Erreur', 'Error')}
              </p>
              <p className="text-sm text-red-700">
                {m.error_code ? <span className="font-mono">#{m.error_code} </span> : null}
                {m.error_message}
              </p>
              {m.error_code && (
                <a
                  href={`https://www.twilio.com/docs/api/errors/${m.error_code}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-xs text-red-700 underline mt-1 inline-block"
                >
                  {bi('Documentation Twilio', 'Twilio docs')} ↗
                </a>
              )}
            </div>
          )}

          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Meta label={bi('Canal', 'Channel')} value={m.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} />
            <Meta label={bi('Expéditeur', 'From')} value={m.from_number || '—'} />
            <Meta label={bi('Coût', 'Cost')} value={fmtCost(m.cost)} />
            <Meta label="Twilio SID" value={m.twilio_sid || '—'} mono />
          </dl>

          {m.related_id && (
            <div>
              <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1">
                {bi('Élément lié', 'Related item')}
              </p>
              {link ? (
                <Link href={link} className="text-sm text-brand hover:text-brand-dark underline">
                  {bi('Ouvrir', 'Open')} ↗ <span className="font-mono text-xs">{m.related_id.slice(0, 8)}</span>
                </Link>
              ) : (
                <p className="text-sm text-ink-secondary font-mono">{m.related_id}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Delivery timeline. Twilio only tells us when the CURRENT status changed,
// so earlier steps show as reached-but-untimed rather than inventing a
// timestamp. created_at is the one exact moment we own.
function Timeline({ m, locale, bi }: { m: MessageRow; locale: string; bi: (fr: string, en: string) => string }) {
  const isFailure = m.status === 'failed' || m.status === 'undelivered'
  const steps: Array<{ key: string; label: string; at: string | null }> = isFailure
    ? [
        { key: 'queued',  label: bi('En file', 'Queued'),  at: m.created_at },
        { key: m.status,  label: bi(STATUS_STYLE[m.status].fr, STATUS_STYLE[m.status].en), at: m.status_updated_at },
      ]
    : [
        { key: 'queued',    label: bi('En file', 'Queued'),   at: m.created_at },
        { key: 'sent',      label: bi('Envoyé', 'Sent'),      at: null },
        { key: 'delivered', label: bi('Livré', 'Delivered'),  at: null },
        ...(m.channel === 'whatsapp' ? [{ key: 'read', label: bi('Lu', 'Read'), at: null }] : []),
      ]

  const order = ['queued', 'sent', 'delivered', 'read']
  const reachedIdx = order.indexOf(m.status)

  return (
    <div>
      <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
        {bi('Suivi de livraison', 'Delivery timeline')}
      </p>
      <ol className="flex flex-wrap items-center gap-1.5">
        {steps.map((s, i) => {
          const stepIdx = order.indexOf(s.key)
          const reached = isFailure ? (i === 0 || m.status_updated_at !== null) : stepIdx <= reachedIdx
          const current = s.key === m.status
          // The current step's timestamp comes from Twilio's callback;
          // 'queued' always uses created_at.
          const at = s.at ?? (current ? m.status_updated_at : null)
          return (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className={`text-xs px-2 py-1 rounded-lg ${
                current   ? (STATUS_STYLE[s.key]?.cls ?? 'bg-surface-muted text-ink-secondary')
                : reached ? 'bg-white text-ink-secondary border border-divider'
                          : 'bg-transparent text-ink-tertiary border border-dashed border-divider'
              }`}>
                {reached ? (STATUS_STYLE[s.key]?.icon ?? '•') : '○'} {s.label}
                {at && <span className="ml-1 text-ink-tertiary">{fmtDateTime(at, locale)}</span>}
              </span>
              {i < steps.length - 1 && <span className="text-ink-tertiary text-xs">→</span>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold text-ink-secondary uppercase tracking-wide">{label}</dt>
      <dd className={`text-sm text-ink-primary break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}

// ── Stats ────────────────────────────────────────────────────────────────────

function StatsBar({ stats, bi }: { stats: Stats | null; bi: (fr: string, en: string) => string }) {
  if (!stats) {
    return <div className="h-20 bg-surface-muted rounded-2xl animate-pulse mb-5" />
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
      <StatCard label={bi("Aujourd'hui", 'Today')}      value={String(stats.today)} />
      <StatCard label={bi('7 jours', 'Last 7 days')}    value={String(stats.week)} />
      <StatCard label={bi('30 jours', 'Last 30 days')}  value={String(stats.month)} />
      <StatCard
        label={bi('Taux de livraison', 'Delivery rate')}
        value={stats.deliveryRate === null ? '—' : `${stats.deliveryRate}%`}
        tone={stats.deliveryRate !== null && stats.deliveryRate < 80 ? 'warn' : 'good'}
        hint={bi(`${stats.delivered + stats.read}/${stats.windowTotal}`, `${stats.delivered + stats.read}/${stats.windowTotal}`)}
      />
      <StatCard
        label={bi('Taux de lecture', 'Read rate')}
        value={stats.readRate === null ? '—' : `${stats.readRate}%`}
        hint={bi('WhatsApp seul', 'WhatsApp only')}
      />
      <StatCard
        label={bi('Échecs', 'Failed')}
        value={String(stats.failed + stats.undelivered)}
        tone={stats.failed + stats.undelivered > 0 ? 'bad' : 'good'}
        hint={`$${stats.totalCost.toFixed(2)} ${bi('coût', 'cost')}`}
      />
    </div>
  )
}

function StatCard({
  label, value, hint, tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}) {
  const toneCls =
    tone === 'bad'  ? 'text-red-600'
    : tone === 'warn' ? 'text-amber-600'
    : tone === 'good' ? 'text-ink-primary'
    : 'text-ink-primary'
  return (
    <div className="bg-white rounded-2xl border border-divider p-3">
      <p className="text-[11px] font-semibold text-ink-secondary uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${toneCls}`}>{value}</p>
      {hint && <p className="text-[11px] text-ink-tertiary mt-0.5">{hint}</p>}
    </div>
  )
}
