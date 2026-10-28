// #5 — event capacity per DAY and per TIER (supabase-event-day-capacity.sql).
//
// What it pins:
//   - A tier sold out on one day stays available on the others.
//   - The event-wide cap (max_tickets) is per day too.
//   - Multi-day bookings need a valid day; single-day ones default to it.
//   - Concurrent bookings for the last seats: exactly as many succeed as fit.
//   - Cancelling frees the seat on THAT day.
//   - A legacy multi-day row with no day (event_date NULL) counts on every day.
//   - A pending payment older than the hold (30 min) holds nothing.
//   - Editing dates: a single-day event moves its bookings; a range change
//     that would strand bookings is refused.
//   - A ticket paid after its hold expired, pushing a day over capacity, is
//     confirmed AND flagged "oversold" in the audit log.
//
// Bookings go through the real /reserve API (local server, dummy Twilio).
// The oversold step settles in-process: Twilio and PawaPay are stubbed, every
// phone is +999, and event cities are run-namespaced (no subscribers).

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeEvent, makeTier, futureDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { settleDeposit } from '@/lib/payments-settle'

const SUITE = 'api-event-day-capacity'

// In-process sends (the oversold step) must never reach Twilio or PawaPay.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('api.twilio.com')) {
    return new Response(JSON.stringify({ sid: 'SM_TEST', status: 'queued' }), { status: 201 })
  }
  if (url.includes('pawapay')) return new Response('blocked by test', { status: 599 })
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

interface DayAv {
  date: string; past: boolean; capacity: number; sold: number; remaining: number | null; soldOut: boolean
  tiers: Array<{ tier_id: string; capacity: number; sold: number; remaining: number | null; soldOut: boolean }>
}
interface ReserveBody { reservation_ids?: string[]; event_date?: string; remaining?: number; error?: string }

async function availability(eventId: string): Promise<DayAv[]> {
  const r = await api<{ days?: DayAv[] }>(`/api/events/${eventId}/availability`)
  return r.body.days ?? []
}

async function main(): Promise<void> {
  try {
    const organizer = await makeCustomer({ suiteNo: 63, name: 'Day organizer', extra: { event_auto_approve: false } })
    const orgCookie = customerCookie(organizer)
    const bookers = await Promise.all([1, 2, 3, 4, 5, 6].map(i => makeCustomer({ suiteNo: 63, name: `Day booker ${i}` })))
    const cookie = (i: number) => customerCookie(bookers[i])

    const reserve = async (eventId: string, body: Record<string, unknown>, who = 0) => {
      const r = await api<ReserveBody>(`/api/events/${eventId}/reserve`, { cookie: cookie(who), body })
      for (const id of r.body.reservation_ids ?? []) track('event_reservations', id)
      return r
    }

    const d1 = futureDateISO(2), d2 = futureDateISO(3), d3 = futureDateISO(4)

    // 3-day event: event cap 5 per day, VIP tier cap 2 per day.
    const multi = await makeEvent({
      organizerId: organizer.id, label: 'day_cap_multi', isActive: true,
      date: d1, endDate: d3, maxTickets: 5,
    })
    const vip = await makeTier(multi.id, { name: 'VIP', price: 0, maxQuantity: 2 })
    // No cap of its own: bookings on it only meet the event-wide cap. (Once an
    // event has ticket types every booking names one — V0.)
    const standard = await makeTier(multi.id, { name: 'Standard', price: 0, maxQuantity: 0 })

    await step('a tier sold out on day 1 is still available on day 2', async () => {
      const a = await reserve(multi.id, { event_date: d1, items: [{ tier_id: vip.id, quantity: 2 }] })
      assertEq(a.status, 200, `VIP × 2 on day 1 → 200 (body ${a.raw.slice(0, 160)})`)
      assertEq(a.body.event_date, d1, 'booked for day 1')
      const full = await reserve(multi.id, { event_date: d1, items: [{ tier_id: vip.id, quantity: 1 }] }, 1)
      assertEq(full.status, 409, 'VIP on day 1 again → 409')
      assertEq(full.body.remaining, 0, 'remaining 0')
      const other = await reserve(multi.id, { event_date: d2, items: [{ tier_id: vip.id, quantity: 2 }] }, 1)
      assertEq(other.status, 200, `VIP × 2 on day 2 → 200 (body ${other.raw.slice(0, 160)})`)

      const days = await availability(multi.id)
      const vipOn = (d: string) => days.find(x => x.date === d)?.tiers.find(t => t.tier_id === vip.id)
      assertEq(vipOn(d1)?.soldOut, true, 'availability: VIP day 1 sold out')
      assertEq(vipOn(d3)?.sold, 0, 'availability: VIP day 3 untouched')
      assertEq(days.length, 3, 'one entry per day')
    })

    await step('the event-wide cap applies per day', async () => {
      // Day 2 already holds 2 (VIP). 3 more fills it.
      const fill = await reserve(multi.id, { event_date: d2, items: [{ tier_id: standard.id, quantity: 3 }] }, 2)
      assertEq(fill.status, 200, `3 more on day 2 → 200 (body ${fill.raw.slice(0, 160)})`)
      const over = await reserve(multi.id, { event_date: d2, items: [{ tier_id: standard.id, quantity: 1 }] }, 3)
      assertEq(over.status, 409, 'one more on day 2 → 409')
      assertEq(over.body.remaining, 0, 'remaining 0 on day 2')
      const d3ok = await reserve(multi.id, { event_date: d3, items: [{ tier_id: standard.id, quantity: 5 }] }, 3)
      assertEq(d3ok.status, 200, 'day 3 still takes its full 5')
      const day2 = (await availability(multi.id)).find(x => x.date === d2)
      assertEq(day2?.soldOut, true, 'availability: day 2 sold out')
    })

    await step('multi-day bookings need a valid day', async () => {
      assertEq((await reserve(multi.id, { quantity: 1 }, 4)).status, 400, 'no event_date → 400')
      assertEq((await reserve(multi.id, { event_date: futureDateISO(9), quantity: 1 }, 4)).status, 400, 'outside the event → 400')
    })

    await step('cancelling frees the seat on that day only', async () => {
      const { data: rows } = await sb.from('event_reservations').select('id, event_date, tier_id')
        .eq('event_id', multi.id).eq('tier_id', vip.id).eq('event_date', d1)
      const id = (rows ?? [])[0]?.id as string
      const r = await api(`/api/events/${multi.id}/reservations/${id}/cancel`, { method: 'POST', cookie: cookie(0) })
      assertEq(r.status, 200, 'cancel → 200')
      const days = await availability(multi.id)
      assertEq(days.find(x => x.date === d1)?.tiers.find(t => t.tier_id === vip.id)?.sold, 0, 'VIP day 1 back to 0')
      assertEq(days.find(x => x.date === d2)?.tiers.find(t => t.tier_id === vip.id)?.sold, 2, 'VIP day 2 unchanged')
    })

    await step('single-day event: event_date defaults to its day', async () => {
      const single = await makeEvent({ organizerId: organizer.id, label: 'day_cap_single', isActive: true, date: d1, maxTickets: 3 })
      const r = await reserve(single.id, { quantity: 1 }, 4)
      assertEq(r.status, 200, 'no event_date needed → 200')
      assertEq(r.body.event_date, d1, 'stored on the event day')
    })

    await step('concurrent bookings for the last 2 seats: exactly 2 succeed', async () => {
      const ev = await makeEvent({ organizerId: organizer.id, label: 'day_cap_race', isActive: true, date: d1, maxTickets: 2 })
      const results = await Promise.all([0, 1, 2, 3, 4].map(i => reserve(ev.id, { quantity: 1 }, i)))
      const codes = results.map(r => r.status).sort()
      assertEq(codes.filter(c => c === 200).length, 2, `two 200s (${codes.join(',')})`)
      assertEq(codes.filter(c => c === 409).length, 3, 'three 409s')
      assertEq((await availability(ev.id))[0]?.sold, 2, 'exactly 2 seats held')
    })

    // Rows inserted directly to model legacy / stale states.
    const insertRow = async (eventId: string, extra: Record<string, unknown>) => {
      const { data, error } = await sb.from('event_reservations').insert({
        event_id: eventId, customer_id: bookers[5].id, customer_name: bookers[5].name,
        customer_phone: bookers[5].phone, quantity: 1, ...extra,
      } as never).select('id').single()
      if (error || !data) throw new Error(`insert reservation: ${error?.message}`)
      track('event_reservations', (data as { id: string }).id)
      return (data as { id: string }).id
    }

    await step('a legacy row with no day counts against every day', async () => {
      const ev = await makeEvent({ organizerId: organizer.id, label: 'day_cap_legacy', isActive: true, date: d1, endDate: d2, maxTickets: 1 })
      await insertRow(ev.id, { event_date: null })
      assertEq((await reserve(ev.id, { event_date: d1, quantity: 1 }, 4)).status, 409, 'day 1 full')
      assertEq((await reserve(ev.id, { event_date: d2, quantity: 1 }, 4)).status, 409, 'day 2 full too')
    })

    await step('a pending payment older than the hold holds no seat', async () => {
      const ev = await makeEvent({ organizerId: organizer.id, label: 'day_cap_stale', isActive: true, date: d1, maxTickets: 1 })
      await insertRow(ev.id, {
        event_date: d1, payment_status: 'pending', payment_id: testName('dep_stale'),
        created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
      })
      assertEq((await reserve(ev.id, { quantity: 1 }, 4)).status, 200, 'the seat is free again → 200')
    })

    await step('a late payment that overflows is confirmed and flagged oversold', async () => {
      // Cap 1; a stale pending row (hold expired) lost its seat to a new
      // booking; now its payment completes.
      const ev = await makeEvent({ organizerId: organizer.id, label: 'day_cap_over', isActive: true, date: d1, maxTickets: 1 })
      const dep = testName('dep_late')
      const late = await insertRow(ev.id, {
        event_date: d1, payment_status: 'pending', payment_id: dep,
        created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
      })
      assertEq((await reserve(ev.id, { quantity: 1 }, 4)).status, 200, 'the seat went to someone else')
      const r = await settleDeposit(dep, { status: 'COMPLETED' }, 'webhook')
      assertEq(r.kind !== 'unknown' && r.action, 'paid', 'late payment settles as paid (customer confirmed)')
      const { data: audit } = await sb.from('audit_log').select('metadata')
        .eq('action', 'event_reservation_oversold').eq('target_id', late).maybeSingle()
      assert(!!audit, 'audit event_reservation_oversold written')
    })

    await step('editing dates: single-day move carries bookings; stranding a day is refused', async () => {
      const single = await makeEvent({ organizerId: organizer.id, label: 'day_cap_move', isActive: true, date: d1, maxTickets: 5 })
      const booked = await reserve(single.id, { quantity: 1 }, 4)
      const id = booked.body.reservation_ids?.[0] as string
      const mv = await api(`/api/events/${single.id}`, { method: 'PATCH', cookie: orgCookie, body: { date: d2 } })
      assertEq(mv.status, 200, `move to day+1 → 200 (body ${mv.raw.slice(0, 160)})`)
      const { data: row } = await sb.from('event_reservations').select('event_date').eq('id', id).single()
      assertEq(row?.event_date, d2, 'the booking moved with the event')

      // multi: bookings exist on d3 → shrinking the range to end at d2 strands d3.
      const shrink = await api(`/api/events/${multi.id}`, { method: 'PATCH', cookie: orgCookie, body: { end_date: d2 } })
      assertEq(shrink.status, 409, 'range change stranding day 3 bookings → 409')
    })

    await step('Events list status: sold out on one day, other days still open', async () => {
      const ev = await makeEvent({ organizerId: organizer.id, label: 'day_cap_card', isActive: true, date: d1, endDate: d2, maxTickets: 1 })
      assertEq((await reserve(ev.id, { event_date: d1, quantity: 1 }, 4)).status, 200, 'day 1 filled')
      const r = await api<{ status?: Record<string, { date: string; soldOut: boolean; otherDaysAvailable: boolean }> }>(
        `/api/events/availability?q=${ev.id}:${d1},${multi.id}:${d3},not-an-id:${d1}`)
      assertEq(r.status, 200, 'HTTP 200')
      const st = r.body.status ?? {}
      assertEq(st[ev.id]?.soldOut, true, 'day 1 → soldOut')
      assertEq(st[ev.id]?.otherDaysAvailable, true, 'day 2 still has room → otherDaysAvailable')
      assertEq(st[multi.id]?.date, d3, 'each event answered for its own day')
      assertEq(Object.keys(st).length, 2, 'a malformed pair is ignored')
    })

    await step('with tiers, capacity per day = sum of the tiers\' max (kept in sync)', async () => {
      const ev = await makeEvent({ organizerId: organizer.id, label: 'day_cap_sync', isActive: true, date: d1, endDate: d2, maxTickets: 9 })
      const cap = async () => ((await sb.from('events').select('max_tickets').eq('id', ev.id).single()).data as { max_tickets: number }).max_tickets
      const addTier = (name: string, max: number) => api<{ tier?: { id: string } }>(`/api/events/${ev.id}/tiers`, {
        method: 'POST', cookie: orgCookie, body: { name: testName(name), price: 0, max_quantity: max },
      })
      const a = await addTier('a', 2)
      assertEq(a.status, 200, `tier A created (body ${a.raw.slice(0, 120)})`)
      assertEq(await cap(), 2, 'first tier (max 2) → capacity 2')
      const b = await addTier('b', 3)
      assertEq(await cap(), 5, 'second tier (max 3) → capacity 5')
      const bId = b.body.tier?.id as string
      await api(`/api/events/${ev.id}/tiers/${bId}`, { method: 'PATCH', cookie: orgCookie, body: { max_quantity: 4 } })
      assertEq(await cap(), 6, 'tier B max 3 → 4 → capacity 6')

      const set = await api(`/api/events/${ev.id}/settings`, { method: 'PATCH', cookie: orgCookie, body: { max_tickets: 20 } })
      assertEq(set.status, 409, 'capacity typed by hand with tiers → 409')
      await api(`/api/events/${ev.id}`, { method: 'PATCH', cookie: orgCookie, body: { max_tickets: 20 } })
      assertEq(await cap(), 6, 'event edit ignores a typed capacity when tiers exist')

      const u = await addTier('unlimited', 0)
      assertEq(await cap(), 0, 'a tier without a max → unlimited (0)')
      await api(`/api/events/${ev.id}/tiers/${u.body.tier?.id}`, { method: 'DELETE', cookie: orgCookie })
      assertEq(await cap(), 6, 'removing it → back to 6')
    })

    await step('submitting an event with tiers stores their sum as the capacity', async () => {
      const r = await api<{ event_id?: string }>('/api/events/submit', {
        method: 'POST', cookie: orgCookie, body: {
          title: testName('day_cap_submit'), date: d1, end_date: d3, city: testName('city'), category: 'Autre',
          whatsapp: organizer.phone, ticket_price: 0, max_tickets: 50,
          tiers: [{ name: 'A', price: 0, max_quantity: 2 }, { name: 'B', price: 0, max_quantity: 1 }],
        },
      })
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      const id = r.body.event_id as string
      track('events', id)
      const { data } = await sb.from('events').select('max_tickets').eq('id', id).single()
      assertEq((data as { max_tickets: number } | null)?.max_tickets, 3, 'max_tickets = 2 + 1 (the typed 50 is ignored)')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
