// What a scanned QR shows, and the one-press validation (Q2). Server-only.
//
//   loadScan(kind, id, session)   → ScanView: never changes anything (links
//                                   are pre-opened by WhatsApp / browsers)
//   redeemScan(kind, id, session) → the button: check in / hand over /
//                                   redeem, atomically, once
//
// Who may validate:
//   booking  the event's organiser, its door staff (Q4), an admin — and the
//            event needs Contrôle des billets (ticket_control)
//   order    owner / manager / staff of THAT restaurant, an admin — and the
//            restaurant takes orders (Commandes)
//   voucher  a restaurant's own voucher: that restaurant's team; a voucher
//            valid everywhere: any restaurant team (the restaurant is
//            recorded); an admin
// Anyone else gets a neutral view (no name, no phone); the customer who owns
// the item sees their own ticket / order / voucher.
// Texts are "FR / EN"; the page picks the viewer's language.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { isEventOrganizer } from '@/lib/eventAuth'
import { eventAllows, restaurantModules } from '@/lib/modulesServer'
import { dateInZone, restaurantZone } from '@/lib/offers'
import { eventDays, formatEventDay } from '@/lib/eventDate'
import { orderCode, reservationCode } from '@/lib/shortCode'
import { isPercentDiscount } from '@/lib/vouchers'
import { formatFCFA } from '@/lib/money'
import { handoverRefusal, isHandedOver, markOrderDelivered, ORDER_COLUMNS, type OrderRow, type DeliveredBy } from '@/lib/orderDelivery'
import type { ScanKind } from '@/lib/scanTokens'

export interface ScanSession { id: string; role: string; name?: string }
export type ScanAccess = 'staff' | 'owner' | 'none'
export type ScanState = 'ready' | 'used' | 'refused'
export type ScanAction = 'checkin' | 'handover' | 'redeem'
export type ScanVia = 'scan' | 'code'

export interface ScanDetails {
  title: string
  subtitle?: string
  code: string
  lines: string[]               // already formatted; "FR / EN" where needed
  people?: number
  dayLabel?: string             // "Jour 2 / Day 2" for a multi-day ticket
}

export interface ScanView {
  kind: ScanKind
  access: ScanAccess
  state?: ScanState
  action?: ScanAction
  reason?: string
  usedAt?: string
  usedBy?: string
  details?: ScanDetails
  // A voucher valid everywhere, scanned by someone on several teams: which
  // restaurant redeems it.
  restaurants?: Array<{ id: string; name: string }>
}

const ADMIN_ROLES = ['super_admin', 'admin', 'moderator']
const isAdmin = (s: ScanSession | null) => !!s && ADMIN_ROLES.includes(s.role)
const isCustomer = (s: ScanSession | null) => !!s && s.role === 'customer'

async function actorName(id: string | null | undefined, type: string | null | undefined): Promise<string> {
  if (!id) return ''
  const table = type === 'admin' ? 'admin_users' : 'customers'
  const { data } = await supabaseAdmin.from(table).select('name').eq('id', id).maybeSingle()
  return ((data?.name as string | undefined) ?? '').split(' ')[0]
}

async function teamRestaurants(customerId: string): Promise<string[]> {
  const { data } = await supabaseAdmin.from('restaurant_team')
    .select('restaurant_id').eq('customer_id', customerId).eq('status', 'active')
  return ((data ?? []) as Array<{ restaurant_id: string }>).map(r => r.restaurant_id)
}

async function isDoorStaff(eventId: string, customerId: string): Promise<boolean> {
  const { count } = await supabaseAdmin.from('event_door_staff').select('id', { count: 'exact', head: true })
    .eq('event_id', eventId).eq('customer_id', customerId).eq('status', 'active')
  return (count ?? 0) > 0
}

// ── Event bookings ──────────────────────────────────────────────────────────

interface BookingRow {
  id: string; event_id: string; customer_id: string | null; quantity: number; reservation_status: string
  payment_status: string | null; event_date: string | null; tier_name: string | null; reservation_code: string | null
  booking_id?: string | null
}
interface EventRow {
  id: string; title: string; venue: string | null; city: string | null; organizer_id: string | null
  submitted_by: string | null; managed_by_platform: boolean | null
  date: string; end_date: string | null; time: string | null; end_time: string | null
}

async function loadBooking(id: string): Promise<{ rows: BookingRow[]; event: EventRow } | null> {
  const cols = 'id, event_id, customer_id, quantity, reservation_status, payment_status, event_date, tier_name, reservation_code'
  const { data: first } = await supabaseAdmin.from('event_reservations').select(cols).eq('id', id).maybeSingle()
  if (!first) return null
  // The booking's other rows (one per tier), when booking_id exists.
  let rows: BookingRow[] = [first as BookingRow]
  const { data: siblings, error } = await supabaseAdmin.from('event_reservations').select(cols).eq('booking_id', id)
  if (!error && siblings && siblings.length > 0) rows = siblings as BookingRow[]
  const { data: ev } = await supabaseAdmin.from('events')
    .select('id, title, venue, city, organizer_id, submitted_by, managed_by_platform, date, end_date, time, end_time')
    .eq('id', (first as BookingRow).event_id).maybeSingle()
  if (!ev) return null
  return { rows, event: ev as EventRow }
}

async function bookingAccess(b: { rows: BookingRow[]; event: EventRow }, s: ScanSession | null): Promise<ScanAccess> {
  if (!s) return 'none'
  if (isAdmin(s)) return 'staff'
  if (!isCustomer(s)) return 'none'
  if (isEventOrganizer(b.event, s.id) || await isDoorStaff(b.event.id, s.id)) return 'staff'
  if (b.rows.some(r => r.customer_id === s.id)) return 'owner'
  return 'none'
}

function bookingDetails(b: { rows: BookingRow[]; event: EventRow }, today: string): ScanDetails {
  const live = b.rows.filter(r => !['cancelled', 'rejected'].includes(r.reservation_status))
  const people = live.reduce((n, r) => n + Number(r.quantity || 0), 0)
  const days = eventDays(b.event)
  const day = b.rows[0].event_date ?? (days.includes(today) ? today : days[0] ?? b.event.date)
  const idx = days.indexOf(day)
  const tiers = live.filter(r => r.tier_name).map(r => `${r.quantity} × ${r.tier_name}`)
  const sub = (l: 'fr' | 'en') => [b.event.venue, formatEventDay(day, l, 'list')].filter(Boolean).join(' · ')
  return {
    title: b.event.title,
    subtitle: `${sub('fr')} / ${sub('en')}`,
    code: reservationCode(b.rows[0]),
    people,
    dayLabel: days.length > 1 && idx >= 0 ? `Jour ${idx + 1} / Day ${idx + 1}` : undefined,
    lines: [
      `${people} ${people > 1 ? 'personnes / people' : 'personne / person'}`,
      ...tiers,
    ],
  }
}

// The day a booking is checked in for today, or the reason it can't be.
function bookingToday(b: { rows: BookingRow[]; event: EventRow }, today: string): { day: string } | { refusal: string } {
  const live = b.rows.filter(r => !['cancelled', 'rejected'].includes(r.reservation_status))
  if (live.length === 0) return { refusal: 'Réservation annulée / Booking cancelled' }
  if (live.some(r => r.payment_status === 'refunded')) return { refusal: 'Billet remboursé / Ticket refunded' }
  if (live.some(r => r.reservation_status === 'pending')) return { refusal: 'En attente de confirmation par l\'organisateur / Waiting for the organiser\'s confirmation' }
  if (live.some(r => r.payment_status === 'pending' || r.payment_status === 'failed')) return { refusal: 'Paiement non confirmé / Payment not confirmed' }
  const booked = b.rows[0].event_date
  if (booked && booked !== today) {
    return { refusal: `Billet pour le ${formatEventDay(booked, 'fr', 'list')}, pas aujourd'hui / Ticket for ${formatEventDay(booked, 'en', 'list')}, not today` }
  }
  if (!booked && !eventDays(b.event).includes(today)) return { refusal: 'L\'événement n\'a pas lieu aujourd\'hui / The event is not on today' }
  return { day: today }
}

async function loadBookingView(id: string, s: ScanSession | null): Promise<ScanView> {
  const b = await loadBooking(id)
  if (!b) return { kind: 'reservation', access: 'none', state: 'refused', reason: 'Billet introuvable / Ticket not found' }
  const access = await bookingAccess(b, s)
  if (access === 'none') return { kind: 'reservation', access }
  const today = dateInZone(restaurantZone({ city: b.event.city }))
  const details = bookingDetails(b, today)
  const { data: done } = await supabaseAdmin.from('event_checkins')
    .select('created_at, checked_in_by, checked_in_by_type').eq('reservation_id', b.rows[0].id).eq('day', today).maybeSingle()
  if (done) {
    return { kind: 'reservation', access, details, state: 'used', usedAt: done.created_at as string,
      usedBy: await actorName(done.checked_in_by as string | null, done.checked_in_by_type as string) }
  }
  const t = bookingToday(b, today)
  if ('refusal' in t) return { kind: 'reservation', access, details, state: 'refused', reason: t.refusal }
  if (access === 'staff' && !(await eventAllows(b.event, 'ticket_control'))) {
    return { kind: 'reservation', access, details, state: 'refused', reason: 'Contrôle des billets non activé pour cet événement / Ticket control is not switched on for this event' }
  }
  return { kind: 'reservation', access, details, state: 'ready', action: access === 'staff' ? 'checkin' : undefined }
}

// ── Orders ──────────────────────────────────────────────────────────────────

async function loadOrder(id: string): Promise<{ order: OrderRow; restaurant: { id: string; name: string } } | null> {
  const { data: o } = await supabaseAdmin.from('orders').select(ORDER_COLUMNS).eq('id', id).maybeSingle()
  if (!o) return null
  const { data: r } = await supabaseAdmin.from('restaurants').select('id, name').eq('id', (o as OrderRow).restaurant_id).maybeSingle()
  return { order: o as OrderRow, restaurant: { id: (o as OrderRow).restaurant_id, name: (r?.name as string | undefined) ?? '' } }
}

async function orderAccess(o: OrderRow, s: ScanSession | null): Promise<ScanAccess> {
  if (!s) return 'none'
  if (isAdmin(s)) return 'staff'
  if (!isCustomer(s)) return 'none'
  if ((await teamRestaurants(s.id)).includes(o.restaurant_id)) return 'staff'
  if (o.customer_id === s.id) return 'owner'
  return 'none'
}

function orderDetails(o: OrderRow, restaurantName: string, access: ScanAccess): ScanDetails {
  const items = Array.isArray(o.items) ? (o.items as Array<{ name: string; quantity: number }>) : []
  return {
    title: restaurantName,
    subtitle: o.fulfilment === 'delivery' ? 'Livraison / Delivery' : 'À emporter / Take-away',
    code: orderCode(o.id),
    lines: [
      ...items.map(i => `${i.quantity} × ${i.name}`),
      `Total : ${formatFCFA(Number(o.total_price))}`,
      ...(access === 'staff' && o.customer_name ? [`👤 ${o.customer_name}`] : []),
    ],
  }
}

async function loadOrderView(id: string, s: ScanSession | null): Promise<ScanView> {
  const x = await loadOrder(id)
  if (!x) return { kind: 'order', access: 'none', state: 'refused', reason: 'Commande introuvable / Order not found' }
  const access = await orderAccess(x.order, s)
  if (access === 'none') return { kind: 'order', access }
  const details = orderDetails(x.order, x.restaurant.name, access)
  if (isHandedOver(x.order)) {
    return { kind: 'order', access, details, state: 'used', usedAt: x.order.delivered_at ?? undefined,
      usedBy: await actorName(x.order.delivered_actor_id, x.order.delivered_actor_type) }
  }
  const refusal = handoverRefusal(x.order)
  if (refusal) return { kind: 'order', access, details, state: 'refused', reason: refusal }
  if (access === 'staff' && !(await restaurantModules(x.order.restaurant_id)).includes('orders')) {
    return { kind: 'order', access, details, state: 'refused', reason: 'Commandes non activé pour ce restaurant / Orders are not switched on for this restaurant' }
  }
  return { kind: 'order', access, details, state: 'ready', action: access === 'staff' ? 'handover' : undefined }
}

// ── Vouchers ────────────────────────────────────────────────────────────────

interface VoucherRow {
  id: string; customer_id: string | null; used_at: string | null; used_by: string | null; used_by_type: string | null
  vouchers: { id: string; code: string; discount_type: string; discount_value: number; is_active: boolean | null
    expires_at: string | null; restaurant_id: string | null; uses_count: number | null } | null
}

async function loadVoucher(id: string): Promise<VoucherRow | null> {
  const { data } = await supabaseAdmin.from('customer_vouchers')
    .select('id, customer_id, used_at, used_by, used_by_type, vouchers!customer_vouchers_voucher_id_fkey(id, code, discount_type, discount_value, is_active, expires_at, restaurant_id, uses_count)')
    .eq('id', id).maybeSingle()
  return (data as unknown as VoucherRow | null) ?? null
}

// The restaurants this scanner may redeem the voucher for.
async function voucherRestaurants(v: VoucherRow, s: ScanSession | null): Promise<Array<{ id: string; name: string }>> {
  if (!s) return []
  const scope = v.vouchers?.restaurant_id ?? null
  let ids: string[]
  if (isAdmin(s)) ids = scope ? [scope] : []
  else if (isCustomer(s)) ids = (await teamRestaurants(s.id)).filter(r => !scope || r === scope)
  else ids = []
  if (ids.length === 0) return []
  const { data } = await supabaseAdmin.from('restaurants').select('id, name').in('id', ids)
  return ((data ?? []) as Array<{ id: string; name: string }>)
}

function voucherDetails(v: VoucherRow, scopeName: string | null): ScanDetails {
  const vv = v.vouchers!
  const value = isPercentDiscount(vv.discount_type) ? `-${vv.discount_value}%` : `-${formatFCFA(Number(vv.discount_value))}`
  return {
    title: `🎫 ${vv.code}`,
    subtitle: scopeName ?? 'Tous les restaurants / All restaurants',
    code: vv.code,
    lines: [`${value}`],
  }
}

async function loadVoucherView(id: string, s: ScanSession | null): Promise<ScanView> {
  const v = await loadVoucher(id)
  if (!v || !v.vouchers) return { kind: 'voucher', access: 'none', state: 'refused', reason: 'Bon introuvable / Voucher not found' }
  const restaurants = await voucherRestaurants(v, s)
  const access: ScanAccess = restaurants.length > 0 || (isAdmin(s) && !v.vouchers.restaurant_id) ? 'staff'
    : (s && v.customer_id === s.id ? 'owner' : 'none')
  if (access === 'none') return { kind: 'voucher', access }
  let scopeName: string | null = null
  if (v.vouchers.restaurant_id) {
    const { data: r } = await supabaseAdmin.from('restaurants').select('name').eq('id', v.vouchers.restaurant_id).maybeSingle()
    scopeName = (r?.name as string | undefined) ?? null
  }
  const details = voucherDetails(v, scopeName)
  if (v.used_at) return { kind: 'voucher', access, details, state: 'used', usedAt: v.used_at, usedBy: await actorName(v.used_by, v.used_by_type) }
  if (v.vouchers.is_active === false) return { kind: 'voucher', access, details, state: 'refused', reason: 'Bon désactivé / Voucher deactivated' }
  if (v.vouchers.expires_at && new Date(v.vouchers.expires_at) < new Date()) return { kind: 'voucher', access, details, state: 'refused', reason: 'Bon expiré / Voucher expired' }
  if (access === 'staff' && isAdmin(s) && !v.vouchers.restaurant_id) {
    return { kind: 'voucher', access, details, state: 'refused', reason: 'Un bon valable partout s\'utilise par un restaurant / A voucher valid everywhere is redeemed by a restaurant' }
  }
  return { kind: 'voucher', access, details, state: 'ready', action: access === 'staff' ? 'redeem' : undefined,
    restaurants: access === 'staff' && restaurants.length > 1 ? restaurants : undefined }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadScan(kind: ScanKind, id: string, s: ScanSession | null): Promise<ScanView> {
  if (kind === 'reservation') return loadBookingView(id, s)
  if (kind === 'order') return loadOrderView(id, s)
  return loadVoucherView(id, s)
}

export type RedeemResult = { ok: true; view: ScanView } | { ok: false; status: number; view: ScanView }

// The button. Re-checks everything, then one atomic write; whoever loses a
// race gets the "already used" view.
export async function redeemScan(
  kind: ScanKind, id: string, s: ScanSession, opts: { via?: ScanVia; restaurantId?: string } = {},
): Promise<RedeemResult> {
  const view = await loadScan(kind, id, s)
  if (view.access !== 'staff' || view.state !== 'ready' || !view.action) {
    return { ok: false, status: view.access === 'staff' ? 409 : 403, view }
  }
  const actorType = isAdmin(s) ? 'admin' : 'customer'
  const via: ScanVia = opts.via === 'code' ? 'code' : 'scan'

  if (kind === 'reservation') {
    const b = (await loadBooking(id))!
    const today = dateInZone(restaurantZone({ city: b.event.city }))
    const live = b.rows.filter(r => !['cancelled', 'rejected'].includes(r.reservation_status))
    const people = live.reduce((n, r) => n + Number(r.quantity || 0), 0)
    const { error } = await supabaseAdmin.from('event_checkins').insert({
      reservation_id: b.rows[0].id, event_id: b.event.id, day: today, people,
      checked_in_by: s.id, checked_in_by_type: actorType, via,
    })
    if (error) return { ok: false, status: 409, view: await loadScan(kind, id, s) }   // the other scanner won
    await supabaseAdmin.from('event_reservations').update({ reservation_status: 'attended', updated_at: new Date().toISOString() })
      .in('id', live.map(r => r.id)).eq('reservation_status', 'confirmed')
    await writeAudit({
      action: 'event_reservation_attended', targetType: 'event_reservation', targetId: b.rows[0].id,
      performedBy: s.id, performedByType: actorType === 'admin' ? s.role : 'organizer',
      metadata: { event_id: b.event.id, day: today, people, via },
    })
  } else if (kind === 'order') {
    const by: DeliveredBy = via === 'code' ? 'restaurant_code' : 'restaurant_scan'
    const r = await markOrderDelivered(id, by, { id: s.id, type: actorType }, { notify: 'customer' })
    if (!r.ok) return { ok: false, status: 409, view: await loadScan(kind, id, s) }
  } else {
    const v = (await loadVoucher(id))!
    const allowed = await voucherRestaurants(v, s)
    const restaurantId = opts.restaurantId && allowed.some(r => r.id === opts.restaurantId) ? opts.restaurantId
      : allowed.length === 1 ? allowed[0].id : (v.vouchers?.restaurant_id ?? null)
    if (!restaurantId) return { ok: false, status: 400, view: { ...view, reason: 'Choisissez le restaurant / Pick the restaurant' } }
    const { data: rows } = await supabaseAdmin.from('customer_vouchers')
      .update({ used_at: new Date().toISOString(), used_by: s.id, used_by_type: actorType, used_restaurant_id: restaurantId })
      .eq('id', id).is('used_at', null).select('id')
    if (!rows || rows.length === 0) return { ok: false, status: 409, view: await loadScan(kind, id, s) }
    const { data: vv } = await supabaseAdmin.from('vouchers').select('uses_count').eq('id', v.vouchers!.id).maybeSingle()
    await supabaseAdmin.from('vouchers').update({ uses_count: Number(vv?.uses_count ?? 0) + 1 }).eq('id', v.vouchers!.id)
    await writeAudit({
      action: 'voucher_redeemed', targetType: 'voucher', targetId: v.vouchers!.id,
      performedBy: s.id, performedByType: actorType === 'admin' ? s.role : 'vendor',
      metadata: { customer_voucher_id: id, restaurant_id: restaurantId, via },
    })
  }
  return { ok: true, view: await loadScan(kind, id, s) }
}
