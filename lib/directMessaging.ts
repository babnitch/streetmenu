// Direct, targeted, FREE messaging — distinct from the paid city-wide
// broadcast system (lib/subscriptions.ts). Two audiences:
//   • event attendees   — customers who reserved for a specific event
//   • restaurant clients — customers with active / recent orders
// Plus event-update notifications when an organizer edits a live event.
//
// All fan-out goes through subscriptions.fanoutBatched (rate-limited waves),
// each recipient's wrapper localized via pickLang. Per-sender rate limits are
// enforced by counting audit_log rows in the trailing 24h — no new table.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { pickLang, normalizeLang, type Lang } from '@/lib/whatsapp'
import { fanoutBatched } from '@/lib/subscriptions'
import { writeAudit } from '@/lib/audit'

// Reservation rows that count as a real attendee (exclude cancelled/rejected).
const ACTIVE_RESERVATION_STATUSES = ['confirmed', 'pending', 'attended']
// Order statuses that count as "active" (not yet completed or cancelled).
const ACTIVE_ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'ready']

const MAX_MESSAGE_LEN = 1000

// ── Rate limiting (audit-log backed) ─────────────────────────────────────────

// Number of `action` audit rows written for `targetId` in the trailing 24h.
// Used to enforce "N messages per event/restaurant per day" without a table.
export async function messagesSentInLast24h(action: string, targetId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data } = await supabaseAdmin
    .from('audit_log')
    .select('id')
    .eq('action', action)
    .eq('target_id', targetId)
    .gte('created_at', since)
  return (data ?? []).length
}

// ── Localised date helper ────────────────────────────────────────────────────

function fmtDate(dateStr: string, lang: Lang): string {
  const locale = lang === 'en' ? 'en-GB' : 'fr-FR'
  return new Date(dateStr).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })
}

// ── Audience fetchers ────────────────────────────────────────────────────────

interface Recipient { phone: string; name: string; lang: Lang }

// Distinct attendees of an event (one entry per phone), with each recipient's
// preferred language resolved from the joined customer row where available.
export async function getEventAttendees(eventId: string): Promise<Recipient[]> {
  const { data } = await supabaseAdmin
    .from('event_reservations')
    .select('customer_name, customer_phone, reservation_status, customer_id, customers(preferred_language)')
    .eq('event_id', eventId)
    .in('reservation_status', ACTIVE_RESERVATION_STATUSES)
  const seen = new Set<string>()
  const out: Recipient[] = []
  for (const r of (data ?? []) as Array<{ customer_name: string; customer_phone: string; customers?: { preferred_language?: string | null } | null }>) {
    const phone = (r.customer_phone ?? '').trim()
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    out.push({ phone, name: r.customer_name, lang: normalizeLang(r.customers?.preferred_language) })
  }
  return out
}

export type RestaurantAudience = 'active' | 'recent_7days'

// Distinct customers of a restaurant for the given audience.
export async function getRestaurantCustomers(restaurantId: string, target: RestaurantAudience): Promise<Recipient[]> {
  let q = supabaseAdmin
    .from('orders')
    .select('customer_name, customer_phone, status, created_at, customer_id, customers(preferred_language)')
    .eq('restaurant_id', restaurantId)
  if (target === 'active') {
    q = q.in('status', ACTIVE_ORDER_STATUSES)
  } else {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    q = q.gte('created_at', since).neq('status', 'cancelled')
  }
  const { data } = await q
  const seen = new Set<string>()
  const out: Recipient[] = []
  for (const o of (data ?? []) as Array<{ customer_name: string; customer_phone: string; customers?: { preferred_language?: string | null } | null }>) {
    const phone = (o.customer_phone ?? '').trim()
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    out.push({ phone, name: o.customer_name, lang: normalizeLang(o.customers?.preferred_language) })
  }
  return out
}

// ── Event-update notification (Feature 1) ────────────────────────────────────

export interface EventForUpdate {
  id: string
  title: string
  date: string
  time: string | null
  venue: string | null
}

// Which significant fields changed — drives the "what changed" summary. Only
// date/time/venue/price are significant enough to ping attendees about.
export interface SignificantChanges {
  date?: boolean
  time?: boolean
  venue?: boolean
  price?: { to: number | null }
}

export function hasSignificantChange(c: SignificantChanges): boolean {
  return !!(c.date || c.time || c.venue || c.price)
}

function changeSummary(c: SignificantChanges, event: EventForUpdate, lang: Lang): string {
  const parts: string[] = []
  if (c.date)  parts.push(pickLang('nouvelle date', 'new date', lang))
  if (c.time)  parts.push(pickLang('nouvelle heure', 'new time', lang))
  if (c.venue) parts.push(pickLang('nouveau lieu', 'new venue', lang))
  if (c.price) {
    const p = c.price.to
    const priceLabel = p && p > 0 ? `${Number(p).toLocaleString()} FCFA` : pickLang('Gratuit', 'Free', lang)
    parts.push(pickLang(`nouveau prix: ${priceLabel}`, `new price: ${priceLabel}`, lang))
  }
  return parts.join(', ')
}

function formatUpdateMessage(event: EventForUpdate, c: SignificantChanges, lang: Lang): string {
  const summary = changeSummary(c, event, lang)
  const lines = [
    pickLang(`📢 Mise à jour pour ${event.title}:`, `📢 Update for ${event.title}:`, lang),
    summary,
    `📅 ${fmtDate(event.date, lang)}${event.time ? ` — ${event.time}` : ''}`,
  ]
  if (event.venue) lines.push(`📍 ${event.venue}`)
  return lines.join('\n')
}

// Notify every attendee that a live event changed. Returns how many were
// pinged. Writes an event_updated audit row (once) regardless of count.
export async function notifyEventUpdate(
  event: EventForUpdate,
  changes: SignificantChanges,
  performedBy: string,
  performedByType: string,
): Promise<number> {
  const attendees = hasSignificantChange(changes) ? await getEventAttendees(event.id) : []
  let notified = 0
  if (attendees.length > 0) {
    const items = attendees.map(a => ({ phone: a.phone, message: formatUpdateMessage(event, changes, a.lang) }))
    const { ok } = await fanoutBatched(items)
    notified = ok
  }
  await writeAudit({
    action:          'event_updated',
    targetType:      'event',
    targetId:        event.id,
    performedBy,
    performedByType,
    metadata:        { notified, changed: Object.keys(changes) },
  })
  return notified
}

// ── Event message to attendees (Feature 2) ───────────────────────────────────

export interface EventForMessage {
  id: string
  title: string
  date: string
  time: string | null
  venue: string | null
  organizer_name: string | null
}

function formatEventMessage(event: EventForMessage, message: string, lang: Lang): string {
  const organizer = event.organizer_name || pickLang('Organisateur', 'Organizer', lang)
  const lines = [
    pickLang(
      `📨 *Message de ${organizer} à propos de ${event.title}:*`,
      `📨 *Message from ${organizer} about ${event.title}:*`,
      lang,
    ),
    '',
    message,
    '',
    `📅 ${fmtDate(event.date, lang)}${event.time ? ` — ${event.time}` : ''}`,
  ]
  if (event.venue) lines.push(`📍 ${event.venue}`)
  return lines.join('\n')
}

export interface SendResult {
  ok: boolean
  sent_count: number
  error?: string
  rate_limited?: boolean
}

const EVENT_MESSAGE_LIMIT_PER_DAY = 2

// Validate + rate-limit + fan-out a free-text message to an event's attendees.
// The caller must have already verified the sender owns the event.
export async function sendEventMessage(
  event: EventForMessage,
  message: string,
  performedBy: string,
  performedByType: string,
): Promise<SendResult> {
  const trimmed = (message ?? '').trim()
  if (!trimmed) return { ok: false, sent_count: 0, error: 'empty' }
  if (trimmed.length > MAX_MESSAGE_LEN) return { ok: false, sent_count: 0, error: 'too_long' }

  const sentToday = await messagesSentInLast24h('event_message_sent', event.id)
  if (sentToday >= EVENT_MESSAGE_LIMIT_PER_DAY) {
    return { ok: false, sent_count: 0, rate_limited: true, error: 'rate_limited' }
  }

  const attendees = await getEventAttendees(event.id)
  let sent = 0
  if (attendees.length > 0) {
    const items = attendees.map(a => ({ phone: a.phone, message: formatEventMessage(event, trimmed, a.lang) }))
    const { ok } = await fanoutBatched(items)
    sent = ok
  }

  await writeAudit({
    action:          'event_message_sent',
    targetType:      'event',
    targetId:        event.id,
    performedBy,
    performedByType,
    metadata:        { sent, recipients: attendees.length, message: trimmed.slice(0, 200) },
  })
  return { ok: true, sent_count: sent }
}

// ── Restaurant message to customers (Feature 3) ──────────────────────────────

export interface RestaurantForMessage {
  id: string
  name: string
}

function formatRestaurantMessage(restaurant: RestaurantForMessage, message: string, lang: Lang): string {
  return [
    pickLang(`📨 *Message de ${restaurant.name}:*`, `📨 *Message from ${restaurant.name}:*`, lang),
    '',
    message,
  ].join('\n')
}

const RESTAURANT_MESSAGE_LIMIT_PER_DAY = 1

export async function sendRestaurantMessage(
  restaurant: RestaurantForMessage,
  message: string,
  target: RestaurantAudience,
  performedBy: string,
  performedByType: string,
): Promise<SendResult> {
  const trimmed = (message ?? '').trim()
  if (!trimmed) return { ok: false, sent_count: 0, error: 'empty' }
  if (trimmed.length > MAX_MESSAGE_LEN) return { ok: false, sent_count: 0, error: 'too_long' }

  const sentToday = await messagesSentInLast24h('restaurant_message_sent', restaurant.id)
  if (sentToday >= RESTAURANT_MESSAGE_LIMIT_PER_DAY) {
    return { ok: false, sent_count: 0, rate_limited: true, error: 'rate_limited' }
  }

  const customers = await getRestaurantCustomers(restaurant.id, target)
  let sent = 0
  if (customers.length > 0) {
    const items = customers.map(c => ({ phone: c.phone, message: formatRestaurantMessage(restaurant, trimmed, c.lang) }))
    const { ok } = await fanoutBatched(items)
    sent = ok
  }

  await writeAudit({
    action:          'restaurant_message_sent',
    targetType:      'restaurant',
    targetId:        restaurant.id,
    performedBy,
    performedByType,
    metadata:        { sent, recipients: customers.length, target, message: trimmed.slice(0, 200) },
  })
  return { ok: true, sent_count: sent }
}
