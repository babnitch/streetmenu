// Q2 — /scan/<token>: opening never changes anything; only the button does,
// once, atomically, by someone allowed.
//
// Bookings: the organiser (or an admin) checks in the whole booking (4
// places → "4 personnes"), once per day; wrong day, pending payment, no
// Contrôle des billets → refused. Strangers and logged-out viewers see
// nothing personal; the owner sees their own ticket.
// Orders: the restaurant's team hands over (restaurant_scan / _code);
// pending or unpaid online → refused. Delivery: "En livraison" sends the
// code; the customer confirms with the button or "reçu" (customer).
// Vouchers: only the voucher's restaurant (or any team for a voucher valid
// everywhere); the restaurant is recorded.
//
// Every phone is +999; events use a per-run city and are never approved
// from pending.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeEvent, makeOrder, makeVoucher, addTeamMember, futureDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { ensureScanToken } from '../../lib/scanTokens'
import { dateInZone } from '../../lib/offers'

const SUITE = 'api-scan-q2'
const CITY = testName('city')

interface View {
  ok?: boolean; access?: string; state?: string; action?: string; reason?: string; usedBy?: string; usedAt?: string
  details?: { title: string; lines: string[]; people?: number; dayLabel?: string; code: string }
  error?: string; token?: string
}

const today = dateInZone('Africa/Douala')
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

async function messagesTo(phone: string, relatedId?: string): Promise<string[]> {
  let q = sb.from('message_log').select('body').like('to_number', `%${phone.replace('+', '')}%`)
  if (relatedId) q = q.eq('related_id', relatedId)
  const { data } = await q
  return (data ?? []).map(m => String(m.body))
}

async function main(): Promise<void> {
  try {
    const organizer = await makeCustomer({ suiteNo: 85, name: 'Marie Organiser' })
    const buyer = await makeCustomer({ suiteNo: 85, name: 'Q2 Buyer', extra: { city: CITY } })
    const stranger = await makeCustomer({ suiteNo: 85, name: 'Q2 Stranger' })
    const oc = customerCookie(organizer), bc = customerCookie(buyer), sc = customerCookie(stranger)
    const view = (t: string, cookie?: string) => api<View>(`/api/scan/${t}`, { cookie })
    const press = (t: string, cookie?: string, body: Record<string, unknown> = {}) => api<View>(`/api/scan/${t}`, { method: 'POST', cookie, body })

    // ── Bookings ───────────────────────────────────────────────────────
    const ev = await makeEvent({ organizerId: organizer.id, label: 'q2_event', isActive: true, date: today, city: CITY })
    const booked = await api<{ reservation_ids?: string[] }>(`/api/events/${ev.id}/reserve`, { cookie: bc, body: { quantity: 4 } })
    for (const id of booked.body.reservation_ids ?? []) track('event_reservations', id)
    const resId = booked.body.reservation_ids?.[0] ?? ''
    const t = await ensureScanToken('reservation', resId)

    await step('opening the link changes nothing; strangers see nothing personal', async () => {
      assertEq(booked.status, 200, `booked (${booked.raw.slice(0, 80)})`)
      const anon = await view(t)
      assertEq(anon.body.access, 'none', 'logged out → neutral')
      assert(!anon.body.details && !anon.raw.includes(buyer.name) && !anon.raw.includes(buyer.phone), 'no name, no phone')
      assertEq((await view(t, sc)).body.access, 'none', 'stranger → neutral')
      const own = await view(t, bc)
      assertEq([own.body.access, own.body.state, own.body.action], ['owner', 'ready', undefined], 'owner sees their ticket, no button')
      const staff = await view(t, oc)
      assertEq([staff.body.access, staff.body.state, staff.body.action], ['staff', 'ready', 'checkin'], 'organiser: check-in button')
      assertEq(staff.body.details?.people, 4, '4 people')
      const { count } = await sb.from('event_checkins').select('id', { count: 'exact', head: true }).eq('event_id', ev.id)
      assertEq(count, 0, 'nothing checked in by opening')
    })

    await step('only staff can press; two at once → exactly one wins', async () => {
      assertEq((await press(t)).status, 401, 'logged out → 401')
      assertEq((await press(t, sc)).status, 403, 'stranger → 403')
      assertEq((await press(t, bc)).status, 403, 'the customer can\'t check themselves in')
      const [a, b] = await Promise.all([press(t, oc), press(t, oc)])
      assertEq([a.status, b.status].sort(), [200, 409], 'one 200, one 409')
      const again = await view(t, oc)
      assertEq(again.body.state, 'used', 'then "already used"')
      assertEq(again.body.usedBy, 'Marie', 'by Marie')
      assert(!!again.body.usedAt, 'with the time')
      const { data } = await sb.from('event_reservations').select('reservation_status').eq('id', resId).single()
      assertEq(data!.reservation_status, 'attended', 'booking attended')
      const { data: ci } = await sb.from('event_checkins').select('people, day, via').eq('reservation_id', resId)
      assertEq(ci, [{ people: 4, day: today, via: 'scan' }], 'one check-in, the whole group')
    })

    await step('multi-day ticket: one check-in per day ("Jour 2")', async () => {
      const multi = await makeEvent({ organizerId: organizer.id, label: 'q2_multi', isActive: true, date: addDays(today, -1), endDate: addDays(today, 1), city: CITY })
      const { data: r } = await sb.from('event_reservations').insert({
        event_id: multi.id, customer_id: buyer.id, customer_name: buyer.name, customer_phone: buyer.phone,
        quantity: 2, total_price: 0, reservation_status: 'confirmed', payment_status: 'not_required', reservation_code: 'MD01', event_date: null,
      }).select('id').single()
      track('event_reservations', r!.id as string)
      await sb.from('event_checkins').insert({ reservation_id: r!.id, event_id: multi.id, day: addDays(today, -1), people: 2, checked_in_by: organizer.id })
      const tm = await ensureScanToken('reservation', r!.id as string)
      const v = await view(tm, oc)
      assertEq([v.body.state, v.body.details?.dayLabel], ['ready', 'Jour 2 / Day 2'], 'yesterday doesn\'t block today, "Jour 2"')
      assertEq((await press(tm, oc)).status, 200, 'checked in for today')
      assertEq((await view(tm, oc)).body.state, 'used', 'and once only')
    })

    await step('wrong day, unpaid, no Contrôle des billets → refused', async () => {
      const later = await makeEvent({ organizerId: organizer.id, label: 'q2_later', isActive: true, date: futureDateISO(3), city: CITY })
      const lb = await api<{ reservation_ids?: string[] }>(`/api/events/${later.id}/reserve`, { cookie: bc, body: { quantity: 1 } })
      for (const id of lb.body.reservation_ids ?? []) track('event_reservations', id)
      const tl = await ensureScanToken('reservation', lb.body.reservation_ids![0])
      const v = await view(tl, oc)
      assertEq(v.body.state, 'refused', 'refused')
      assert(/pas aujourd'hui|n'a pas lieu aujourd'hui/.test(v.body.reason ?? ''), `wrong-day reason (${v.body.reason})`)
      assertEq((await press(tl, oc)).status, 409, 'button refused')

      const { data: unpaid } = await sb.from('event_reservations').insert({
        event_id: ev.id, customer_id: buyer.id, customer_name: buyer.name, customer_phone: buyer.phone,
        quantity: 1, total_price: 5000, reservation_status: 'confirmed', payment_status: 'pending', reservation_code: 'UP01', event_date: today,
      }).select('id').single()
      track('event_reservations', unpaid!.id as string)
      assert(/Paiement non confirmé/.test((await view(await ensureScanToken('reservation', unpaid!.id as string), oc)).body.reason ?? ''), 'unpaid → refused')

      const plain = await makeCustomer({ suiteNo: 85, name: 'No Control Org', extra: { organizer_modules: ['reservations'] } })
      const ev2 = await makeEvent({ organizerId: plain.id, label: 'q2_noctl', isActive: true, date: today, city: CITY })
      const b2 = await api<{ reservation_ids?: string[] }>(`/api/events/${ev2.id}/reserve`, { cookie: bc, body: { quantity: 1 } })
      for (const id of b2.body.reservation_ids ?? []) track('event_reservations', id)
      const v2 = await view(await ensureScanToken('reservation', b2.body.reservation_ids![0]), customerCookie(plain))
      assert(/Contrôle des billets non activé/.test(v2.body.reason ?? ''), 'no ticket_control → refused')
    })

    await step('managed event (no organiser): an admin checks in', async () => {
      const { data: m } = await sb.from('events').insert({
        title: testName('q2_managed'), category: 'Autre', city: CITY, date: today, is_active: true, event_status: 'upcoming',
        organizer_id: null, managed_by_platform: true, payment_mode: 'reservation_only',
      }).select('id').single()
      track('events', m!.id as string)
      const mb = await api<{ reservation_ids?: string[] }>(`/api/events/${m!.id}/reserve`, { cookie: bc, body: { quantity: 2 } })
      for (const id of mb.body.reservation_ids ?? []) track('event_reservations', id)
      assertEq(mb.status, 200, `booked (${mb.raw.slice(0, 80)})`)
      const tmg = await ensureScanToken('reservation', mb.body.reservation_ids![0])
      const admin = await adminCookie()
      assertEq((await view(tmg, admin)).body.action, 'checkin', 'admin: button')
      assertEq((await press(tmg, admin)).status, 200, 'checked in')
    })

    // ── Orders ────────────────────────────────────────────────────────
    const owner = await makeCustomer({ suiteNo: 85, name: 'Paul Owner' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'q2_r' })
    const otherRest = await makeRestaurant({ label: 'q2_r_other' })
    const otherStaff = await makeCustomer({ suiteNo: 85, name: 'Other Staff' })
    await addTeamMember(otherRest.id, otherStaff.id, 'staff')
    const owc = customerCookie(owner)

    await step('order: pending refused; the team hands over once (restaurant_scan); other teams see nothing', async () => {
      const o = await makeOrder(rest.id, buyer, { status: 'pending' })
      const to = await ensureScanToken('order', o.id)
      assert(/pas encore acceptée/.test((await view(to, owc)).body.reason ?? ''), 'pending → refused')
      await sb.from('orders').update({ status: 'ready' }).eq('id', o.id)
      assertEq((await view(to, customerCookie(otherStaff))).body.access, 'none', 'another restaurant\'s staff → neutral')
      const v = await view(to, owc)
      assertEq([v.body.state, v.body.action], ['ready', 'handover'], 'button "Remis au client"')
      assertEq((await press(to, owc)).status, 200, 'handed over')
      const { data } = await sb.from('orders').select('status, delivered_confirmed_by, delivered_actor_id').eq('id', o.id).single()
      assertEq([data!.status, data!.delivered_confirmed_by, data!.delivered_actor_id], ['delivered', 'restaurant_scan', owner.id], 'recorded')
      assertEq((await press(to, owc)).status, 409, 'second press → already')
      assertEq((await view(to, owc)).body.usedBy, 'Paul', 'by Paul')
    })

    await step('online payment not received → refused', async () => {
      const o = await makeOrder(rest.id, buyer, { status: 'confirmed', extra: { order_type: 'paid_order', payment_status: 'pending' } })
      assert(/Paiement en ligne non confirmé/.test((await view(await ensureScanToken('order', o.id), owc)).body.reason ?? ''), 'refused')
    })

    await step('typed code: order and voucher → same screen, recorded as by code', async () => {
      const o = await makeOrder(rest.id, buyer, { status: 'confirmed' })
      const code = o.id.replace(/-/g, '').slice(-4)
      const c = await api<View>('/api/scan/code', { cookie: owc, body: { restaurant_id: rest.id, code } })
      assertEq(c.status, 200, `found (${c.raw.slice(0, 60)})`)
      assertEq((await press(c.body.token!, owc, { via: 'code' })).status, 200, 'handed over')
      const { data } = await sb.from('orders').select('delivered_confirmed_by').eq('id', o.id).single()
      assertEq(data!.delivered_confirmed_by, 'restaurant_code', 'restaurant_code')
      assertEq((await api('/api/scan/code', { cookie: customerCookie(otherStaff), body: { restaurant_id: rest.id, code } })).status, 403, 'other team can\'t look up')
    })

    await step('delivery: "En livraison" sends the code; the customer confirms (button, then "reçu")', async () => {
      const o1 = await makeOrder(rest.id, buyer, { status: 'ready', extra: { fulfilment: 'delivery', delivery_address: 'Rue des Tests, Bastos', delivery_fee: 500 } })
      const s = await api(`/api/orders/${o1.id}/status`, { cookie: owc, body: { status: 'out_for_delivery' } })
      assertEq(s.status, 200, `out for delivery (${s.raw.slice(0, 60)})`)
      const code1 = o1.id.replace(/-/g, '').slice(-4).toUpperCase()
      assert((await messagesTo(buyer.phone, o1.id)).some(m => m.includes(`*${code1}*`) && /reçu|received/.test(m)), 'customer got the code')
      assertEq((await api(`/api/orders/${o1.id}/received`, { cookie: sc, body: {} })).status, 404, 'someone else can\'t confirm')
      assertEq((await api(`/api/orders/${o1.id}/received`, { cookie: bc, body: {} })).status, 200, 'customer button')
      const { data: d1 } = await sb.from('orders').select('status, delivered_confirmed_by').eq('id', o1.id).single()
      assertEq([d1!.status, d1!.delivered_confirmed_by], ['delivered', 'customer'], 'delivered by the customer')

      const o2 = await makeOrder(rest.id, buyer, { status: 'ready', extra: { fulfilment: 'delivery', delivery_address: 'Rue des Tests, Bastos', delivery_fee: 500 } })
      await api(`/api/orders/${o2.id}/status`, { cookie: owc, body: { status: 'out_for_delivery' } })
      await api('/api/whatsapp/incoming', { form: { From: `whatsapp:${buyer.phone}`, Body: 'reçu' } })
      const { data: d2 } = await sb.from('orders').select('status, delivered_confirmed_by').eq('id', o2.id).single()
      assertEq([d2!.status, d2!.delivered_confirmed_by], ['delivered', 'customer'], '"reçu" on WhatsApp')
      const takeaway = await makeOrder(rest.id, buyer, { status: 'ready' })
      assertEq((await api(`/api/orders/${takeaway.id}/status`, { cookie: owc, body: { status: 'out_for_delivery' } })).status, 409, 'take-away can\'t go out for delivery')
    })

    // ── Vouchers ──────────────────────────────────────────────────────
    await step('voucher: only its restaurant; recorded where; then used', async () => {
      const v = await makeVoucher({ label: 'q2v', restaurantId: rest.id })
      const { data: cv } = await sb.from('customer_vouchers').insert({ customer_id: buyer.id, voucher_id: v.id }).select('id').single()
      track('customer_vouchers', cv!.id as string)
      const tv = await ensureScanToken('voucher', cv!.id as string)
      assertEq((await view(tv, customerCookie(otherStaff))).body.access, 'none', 'another restaurant → neutral')
      assertEq((await press(tv, customerCookie(otherStaff))).status, 403, 'and can\'t redeem')
      assertEq((await view(tv, owc)).body.action, 'redeem', 'its restaurant: button')
      assertEq((await press(tv, owc)).status, 200, 'redeemed')
      const { data } = await sb.from('customer_vouchers').select('used_at, used_by, used_restaurant_id').eq('id', cv!.id).single()
      assert(!!data!.used_at && data!.used_by === owner.id && data!.used_restaurant_id === rest.id, 'who and where recorded')
      assertEq((await view(tv, owc)).body.state, 'used', 'then used')
    })

    await step('voucher valid everywhere: any restaurant team, its restaurant recorded', async () => {
      const g = await makeVoucher({ label: 'q2g' })
      const { data: cv } = await sb.from('customer_vouchers').insert({ customer_id: buyer.id, voucher_id: g.id }).select('id').single()
      track('customer_vouchers', cv!.id as string)
      const tg = await ensureScanToken('voucher', cv!.id as string)
      assertEq((await press(tg, customerCookie(otherStaff))).status, 200, 'other restaurant\'s staff redeems')
      const { data } = await sb.from('customer_vouchers').select('used_restaurant_id').eq('id', cv!.id).single()
      assertEq(data!.used_restaurant_id, otherRest.id, 'their restaurant recorded')
    })

    await step('unknown token → neutral 404', async () => {
      const r = await view('AAAAAAAAAAAAAAAAAAAAAA', oc)
      assertEq([r.status, r.body.access], [404, 'none'], '404, neutral')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
