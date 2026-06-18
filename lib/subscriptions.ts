// Event-subscription + broadcast helpers (server-only).
//
// Two domains in one file because they share the same audience query
// (`active subscribers in city X matching category Y`).

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp, normalizeLang, pickLang, type Lang } from '@/lib/whatsapp'
import { categoryLabelBilingual } from '@/lib/categoryLabels'

// ── Constants ───────────────────────────────────────────────────────────────

export const SUBSCRIPTION_CITIES = ['Yaoundé', 'Abidjan', 'Dakar', 'Lomé'] as const
export const EVENT_CATEGORIES = [
  'Concert', 'Festival', 'BT/Club', 'Sport', 'Culture', 'Gastronomie', 'Enfants', 'Business', 'Autre',
] as const

// Twilio's published WhatsApp rate is ~1 msg/sec on shared-sender, much
// higher on dedicated. Batching 100/min keeps us well inside both.
const MAX_PER_EVENT_NOTIFICATION = 100
const BATCH_SIZE = 20            // sent per Promise.allSettled wave
const BATCH_DELAY_MS = 1000      // sleep between waves → 20/sec ≈ 1200/min

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://streetmenu.vercel.app'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SubscriberRow {
  id:          string
  customer_id: string
  city:        string
  categories:  string[] | null
  customers:   { phone: string; name: string; preferred_language?: string | null } | null
}

interface MatchOpts {
  city: string
  category?: string | null
  limit?: number
}

// ── Audience queries ────────────────────────────────────────────────────────

// Returns the active subscribers whose city matches and either have no
// category filter or include the supplied category in their whitelist.
// Returned with the joined customer row so callers can fire WhatsApp without
// a second roundtrip.
export async function findMatchingSubscribers(opts: MatchOpts): Promise<SubscriberRow[]> {
  const { city, category, limit } = opts
  // Pull every active subscriber for the city; category filter is applied in
  // JS because Postgres `array_position(categories, $1) IS NOT NULL OR
  // categories IS NULL` is awkward through PostgREST.
  const q = supabaseAdmin
    .from('event_subscriptions')
    .select('id, customer_id, city, categories, customers(phone, name, preferred_language)')
    .eq('city', city)
    .eq('is_active', true)

  const { data, error } = limit ? await q.limit(limit) : await q
  if (error) {
    console.error('[subscriptions] findMatchingSubscribers failed:', error.message)
    return []
  }
  const rows = (data ?? []) as unknown as SubscriberRow[]
  if (!category) return rows
  return rows.filter(r => !r.categories || r.categories.length === 0 || r.categories.includes(category))
}

export async function countMatchingSubscribers(opts: MatchOpts): Promise<number> {
  return (await findMatchingSubscribers(opts)).length
}

// ── Pricing ─────────────────────────────────────────────────────────────────

export interface BroadcastPricing {
  price_per_recipient: number
  min_charge:          number
  max_message_length:  number
}

export async function getActivePricing(): Promise<BroadcastPricing> {
  const { data } = await supabaseAdmin
    .from('broadcast_pricing')
    .select('price_per_recipient, min_charge, max_message_length')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? { price_per_recipient: 50, min_charge: 1000, max_message_length: 1000 }
}

export function computeBroadcastCost(recipients: number, pricing: BroadcastPricing): number {
  return Math.max(pricing.min_charge, recipients * pricing.price_per_recipient)
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export interface BroadcastEligibility {
  asPublisher:  boolean                              // verified event publisher
  asRestaurants: Array<{ id: string; name: string }> // approved/active restaurants owned
  blocked:      boolean
}

// A customer can broadcast as a publisher when they're a verified event
// publisher (event_auto_approve=true OR events_approved_count >= 1). They
// can also broadcast on behalf of any restaurant they own that's active
// or approved (status in ('active','approved')).
export async function getBroadcastEligibility(customerId: string): Promise<BroadcastEligibility> {
  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, event_auto_approve, events_approved_count, broadcast_blocked')
    .eq('id', customerId)
    .maybeSingle()

  const asPublisher = !!customer && !customer.broadcast_blocked && (
    customer.event_auto_approve === true ||
    (customer.events_approved_count ?? 0) >= 1
  )

  const { data: rests } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, status, deleted_at')
    .eq('customer_id', customerId)
  const asRestaurants = ((rests ?? []) as Array<{ id: string; name: string; status: string | null; deleted_at: string | null }>)
    .filter(r => !r.deleted_at && (r.status === 'active' || r.status === 'approved'))
    .map(r => ({ id: r.id, name: r.name }))

  return {
    asPublisher,
    asRestaurants: customer?.broadcast_blocked ? [] : asRestaurants,
    blocked: !!customer?.broadcast_blocked,
  }
}

// 1 broadcast / sender / 24h. Counts paid+sending+sent rows so a failed
// payment doesn't lock the sender out for the day.
export async function hasRecentBroadcast(customerId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data } = await supabaseAdmin
    .from('broadcasts')
    .select('id')
    .eq('sender_id', customerId)
    .in('status', ['paid', 'sending', 'sent'])
    .gte('created_at', since)
    .limit(1)
  return (data ?? []).length > 0
}

// ── Fan-out (rate-limited Promise.allSettled batches) ───────────────────────

interface FanoutInput {
  phone:   string
  message: string
}

export async function fanoutBatched(items: FanoutInput[]): Promise<{ ok: number; failed: number }> {
  let ok = 0
  let failed = 0
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const slice = items.slice(i, i + BATCH_SIZE)
    const results = await Promise.allSettled(
      slice.map(item => sendWhatsApp(item.phone, item.message)),
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) ok++
      else failed++
    }
    if (i + BATCH_SIZE < items.length) {
      await new Promise(res => setTimeout(res, BATCH_DELAY_MS))
    }
  }
  return { ok, failed }
}

// ── Event-approval notifications ────────────────────────────────────────────

interface EventForNotify {
  id:           string
  title:        string
  date:         string
  time:         string | null
  venue:        string | null
  city:         string
  category:     string
  price:        number | null
  ticket_price: number | null
}

function formatEventLine(e: EventForNotify, lang: Lang): string {
  const locale = lang === 'en' ? 'en-GB' : 'fr-FR'
  const date = new Date(e.date).toLocaleDateString(locale, {
    day: '2-digit', month: 'short', year: 'numeric',
  })
  const price = e.ticket_price ?? e.price
  const priceLine = price && price > 0
    ? `🎫 ${Number(price).toLocaleString()} FCFA`
    : `🎫 ${pickLang('Gratuit', 'Free', lang)}`
  // `categoryLabelBilingual` returns e.g. "👶 Enfants / 👶 Kids" — we strip
  // to the half matching `lang` so the badge stays single-language.
  const catBi = categoryLabelBilingual(e.category)
  const catParts = catBi.split(' / ')
  const cat = catParts.length === 2 ? (lang === 'en' ? catParts[1] : catParts[0]) : catBi
  const lines = [
    pickLang(`🎉 *Nouvel événement à ${e.city}!*`, `🎉 *New event in ${e.city}!*`, lang),
    ``,
    e.title,
    `📅 ${date}${e.time ? ` — ${e.time}` : ''}`,
  ]
  if (e.venue) lines.push(`📍 ${e.venue}`)
  lines.push(priceLine)
  lines.push(`🏷️ ${cat}`)
  lines.push('')
  lines.push(`${pickLang('Voir les détails', 'See details', lang)}: ${BASE_URL}/events/${e.id}`)
  lines.push('')
  lines.push(pickLang(
    `Envoyez 'desabonner' pour ne plus recevoir ces notifications.`,
    `Send 'unsubscribe' to stop receiving these notifications.`,
    lang,
  ))
  return lines.join('\n')
}

// Fan-out wrapper for the "event was just approved" path. Looks up
// matching subscribers, applies the per-event cap, sends via batched
// WhatsApp, and returns counts so the caller can write an audit row.
export async function notifyEventSubscribers(event: EventForNotify): Promise<{
  recipient_count: number
  ok:              number
  failed:          number
}> {
  const subs = await findMatchingSubscribers({
    city: event.city,
    category: event.category,
    limit: MAX_PER_EVENT_NOTIFICATION,
  })
  if (subs.length === 0) return { recipient_count: 0, ok: 0, failed: 0 }

  // Each subscriber gets the message rendered in their preferred_language.
  // Cheap because formatEventLine is pure string assembly (no I/O).
  const items = subs
    .filter(s => s.customers?.phone)
    .map(s => {
      const lang = normalizeLang(s.customers!.preferred_language)
      return { phone: s.customers!.phone, message: formatEventLine(event, lang) }
    })

  const { ok, failed } = await fanoutBatched(items)
  return { recipient_count: items.length, ok, failed }
}

// ── Broadcast message formatter ─────────────────────────────────────────────

interface BroadcastForFormat {
  title:         string
  message:       string
  sender_name:   string
  restaurant_name?: string | null
  organization?: string | null
  sender_type:   'publisher' | 'restaurant'
}

// The broadcast body/title are sender-authored free text and are sent as-is;
// only the wrapper (header + unsubscribe footer) is localized to the
// recipient's language. The unsubscribe keyword follows lang too — the router
// accepts both 'desabonner' and 'unsubscribe'.
export function formatBroadcastMessage(b: BroadcastForFormat, lang: Lang = 'fr'): string {
  const lines: string[] = []
  lines.push(pickLang(`📢 *Message de ${b.sender_name}*`, `📢 *Message from ${b.sender_name}*`, lang))
  if (b.sender_type === 'restaurant' && b.restaurant_name) {
    lines.push(`🏪 ${b.restaurant_name}`)
  } else if (b.sender_type === 'publisher' && b.organization) {
    lines.push(`🎉 ${b.organization}`)
  }
  if (b.title) {
    lines.push('')
    lines.push(`*${b.title}*`)
  }
  lines.push('')
  lines.push(b.message)
  lines.push('')
  lines.push('—')
  lines.push(pickLang(
    `Envoyez 'desabonner' pour ne plus recevoir ces messages.`,
    `Send 'unsubscribe' to stop receiving these messages.`, lang))
  return lines.join('\n')
}
