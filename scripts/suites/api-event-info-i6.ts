// I6 — "Infos seulement" events: an admin-managed event with no booking,
// payment or QR on the platform — only a "Billets / Infos" link. It is the
// default for an event the admin creates; linking an organiser switches it
// to platform bookings. Per-run city, +999 phones: no real subscriber.

import { sb, testName, testPhone } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, customerCookie } from '../testkit/session'
import { makeCustomer, futureDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-event-info-i6'
const CITY = testName('city_i6')

interface Body { ok?: boolean; error?: string; field?: string; reason?: string; event?: Record<string, unknown> & { id: string }; reservation_id?: string; booking?: { reservations: boolean; paid_tickets: boolean }; organizer?: { id: string } }

async function main(): Promise<void> {
  try {
    const admin = await adminCookie()
    const base = { title: testName('i6_event'), category: 'Concert', city: CITY, date: futureDateISO(5), end_date: futureDateISO(7), time: '19:00', venue: 'Test Hall', price: 3000, organizer_name: 'I6 Promoteur' }
    let eid = ''

    await step('admin create: info only by default, link checked', async () => {
      const bad = await api<Body>('/api/admin/events', { cookie: admin, body: { ...base, info_link: 'javascript:alert(1)' } })
      assertEq([bad.status, bad.body.field], [400, 'info_link'], 'bad link → 400')
      const r = await api<Body>('/api/admin/events', { cookie: admin, body: { ...base, info_link: 'https://tickets.example/i6', price_is_from: true, max_tickets: 50 } })
      assertEq(r.status, 200, `created (${r.raw.slice(0, 80)})`)
      eid = r.body.event!.id
      track('events', eid)
      const { data } = await sb.from('events').select('booking_mode, info_link, price_is_from, max_tickets, managed_by_platform, organizer_name, cover_photo').eq('id', eid).single()
      assertEq(data, { booking_mode: 'info', info_link: 'https://tickets.example/i6', price_is_from: true, max_tickets: 0, managed_by_platform: true, organizer_name: 'I6 Promoteur', cover_photo: null },
        'info only, link, "from" price, no seats, generated cover')
    })

    await step('no booking on any path', async () => {
      const av = await api<Body>(`/api/events/${eid}/availability`)
      assertEq(av.body.booking, { reservations: false, paid_tickets: false }, 'booking flags off')
      const buyer = await makeCustomer({ suiteNo: 96, name: 'I6 Buyer', extra: { city: CITY } })
      const res = await api<Body>(`/api/events/${eid}/reserve`, { cookie: customerCookie(buyer), body: { quantity: 1, date: base.date } })
      if (res.body.reservation_id) track('event_reservations', res.body.reservation_id)
      assertEq(res.status, 403, `reserve refused (${res.raw.slice(0, 80)})`)
      const pay = await api<Body>(`/api/events/${eid}/pay`, { cookie: customerCookie(buyer), body: { quantity: 1, phoneNumber: buyer.phone } })
      assertEq(pay.status, 403, `pay refused (${pay.raw.slice(0, 80)})`)
      const { count } = await sb.from('event_reservations').select('id', { count: 'exact', head: true }).eq('event_id', eid)
      assertEq(count, 0, 'no reservation row')
    })

    await step('explicit platform mode still takes free reservations', async () => {
      const r = await api<Body>('/api/admin/events', { cookie: admin, body: { ...base, title: testName('i6_platform'), booking_mode: 'platform', end_date: '' } })
      assertEq(r.status, 200, 'created')
      track('events', r.body.event!.id)
      const { data } = await sb.from('events').select('booking_mode').eq('id', r.body.event!.id).single()
      assertEq(data!.booking_mode, 'platform', 'platform')
      const av = await api<Body>(`/api/events/${r.body.event!.id}/availability`)
      assertEq(av.body.booking?.reservations, true, 'reservations on')
    })

    await step('linking an organiser switches to platform bookings', async () => {
      const r = await api<Body>(`/api/admin/events/${eid}/organizer`, { cookie: admin, body: { mode: 'link', phone: testPhone(96, 9601), name: 'I6 Organiser' } })
      assertEq(r.status, 200, `linked (${r.raw.slice(0, 80)})`)
      if (r.body.organizer?.id) track('customers', r.body.organizer.id)
      const { data } = await sb.from('events').select('booking_mode, managed_by_platform').eq('id', eid).single()
      assertEq(data, { booking_mode: 'platform', managed_by_platform: false }, 'platform, not managed')
    })
    assert(true, 'done')
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
