// Server side of "Commandes en ligne en pause" (see lib/ordersPause.ts).
//
// Works before supabase-orders-pause.sql has run: reading a missing column
// returns an error, which reads as "not paused, feature not available" — so
// orders keep flowing and the dashboard hides the switch.

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { isRestaurantOpen, timezoneForCity } from '@/lib/openingHours'
import { isOrdersPaused, ordersPausedText, ORDERS_PAUSED_ERROR, type PauseChoice, type Lang } from '@/lib/ordersPause'

export interface OrdersPauseState {
  /** False until the SQL has added the columns. */
  available: boolean
  paused: boolean
  paused_at: string | null
  /** null while paused = until turned back on. */
  until: string | null
}

const NOT_AVAILABLE: OrdersPauseState = { available: false, paused: false, paused_at: null, until: null }

export async function readOrdersPause(restaurantId: string, now: Date = new Date()): Promise<OrdersPauseState> {
  const { data, error } = await supabaseAdmin
    .from('restaurants').select('orders_paused_at, orders_paused_until').eq('id', restaurantId).maybeSingle()
  if (error) return NOT_AVAILABLE
  const row = (data ?? {}) as { orders_paused_at?: string | null; orders_paused_until?: string | null }
  const paused = isOrdersPaused(row, now)
  return {
    available: true,
    paused,
    paused_at: paused ? row.orders_paused_at ?? null : null,
    until: paused ? row.orders_paused_until ?? null : null,
  }
}

/**
 * The gate for every new online order. null = go ahead; otherwise a 409
 * { reason: 'orders_paused', phone } the checkout shows as is.
 */
export async function ordersPausedRefusal(restaurantId: string): Promise<NextResponse | null> {
  const s = await readOrdersPause(restaurantId)
  if (!s.paused) return null
  const { data: r } = await supabaseAdmin.from('restaurants').select('phone, whatsapp').eq('id', restaurantId).maybeSingle()
  return NextResponse.json(
    { error: ORDERS_PAUSED_ERROR, reason: 'orders_paused', until: s.until, phone: r?.phone || r?.whatsapp || null },
    { status: 409 },
  )
}

/** Bot line for a paused restaurant, or null when it takes orders. */
export async function ordersPausedBotText(restaurantId: string, restaurantName: string, lang: Lang): Promise<string | null> {
  const s = await readOrdersPause(restaurantId)
  if (!s.paused) return null
  const { data: r } = await supabaseAdmin.from('restaurants').select('phone, whatsapp').eq('id', restaurantId).maybeSingle()
  return ordersPausedText(lang, restaurantName, r?.phone || r?.whatsapp || null)
}

/**
 * Minutes from now to tonight's closing in the restaurant's schedule (its
 * time zone). The manual open/closed override is ignored on purpose: the
 * pause follows the opening hours. No hours / closed now → end of the local
 * day, so "until tonight" never runs into tomorrow.
 */
export async function minutesUntilClosing(restaurantId: string, now: Date = new Date()): Promise<number> {
  const [{ data: rest }, { data: hours }] = await Promise.all([
    supabaseAdmin.from('restaurants').select('city, timezone').eq('id', restaurantId).maybeSingle(),
    supabaseAdmin.from('restaurant_hours').select('day_of_week, open_time, close_time, is_closed').eq('restaurant_id', restaurantId),
  ])
  const status = isRestaurantOpen({
    manual_override: null,
    timezone: rest?.timezone || timezoneForCity(rest?.city),
    hours: (hours ?? []).map(h => ({
      day_of_week: h.day_of_week, open_time: String(h.open_time).slice(0, 5),
      close_time: String(h.close_time).slice(0, 5), is_closed: !!h.is_closed,
    })),
  }, now)
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
  const nowMin = toMin(status.current_time)
  const next = status.next_transition
  if (status.open && next?.kind === 'closes') {
    const diff = toMin(next.at) - nowMin + (next.day !== status.current_day ? 1440 : 0)
    if (diff > 0) return diff
  }
  return Math.max(1, 1440 - nowMin)
}

export interface PauseActor { id: string | null; type: string; via: 'web' | 'whatsapp' }

export type SetPauseResult =
  | { ok: true; state: OrdersPauseState }
  | { ok: false; status: number; error: string }

/** Pause (choice or minutes) or resume (null), with an audit row. */
export async function setOrdersPause(
  restaurantId: string,
  pause: { choice: PauseChoice } | { minutes: number } | null,
  actor: PauseActor,
  now: Date = new Date(),
): Promise<SetPauseResult> {
  const before = await readOrdersPause(restaurantId, now)
  if (!before.available) {
    return { ok: false, status: 503, error: 'Pause pas encore disponible / Pause not available yet' }
  }
  let until: string | null = null
  let choice: string
  if (pause === null) {
    choice = 'resume'
  } else {
    let minutes: number | null = null
    if ('minutes' in pause) { minutes = pause.minutes; choice = `${pause.minutes}m` }
    else {
      choice = pause.choice
      if (pause.choice === '30m') minutes = 30
      else if (pause.choice === '1h') minutes = 60
      else if (pause.choice === 'closing') minutes = await minutesUntilClosing(restaurantId, now)
    }
    until = minutes === null ? null : new Date(now.getTime() + minutes * 60_000).toISOString()
  }
  const update = pause === null
    ? { orders_paused_at: null, orders_paused_until: null }
    : { orders_paused_at: now.toISOString(), orders_paused_until: until }
  const { error } = await supabaseAdmin.from('restaurants').update(update as never).eq('id', restaurantId).is('deleted_at', null)
  if (error) return { ok: false, status: 500, error: error.message }

  await writeAudit({
    action: pause === null ? 'orders_resumed' : 'orders_paused',
    targetType: 'restaurant',
    targetId: restaurantId,
    performedBy: actor.id,
    performedByType: actor.type,
    metadata: { choice, until, via: actor.via, was_paused: before.paused },
  })
  return { ok: true, state: await readOrdersPause(restaurantId, now) }
}
