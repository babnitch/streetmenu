// N3b — admin-managed events ("managed by Tchop & Ndjoka", no organiser).
//
// The admin creates an event with no organiser: nobody is messaged, it takes
// free reservations only (no paid tickets) until an organiser is linked; a
// bookings number can be set; linking an account makes it the organiser
// (their modules apply), still without a message.
//
// Every phone is +999; a per-run city, so no real subscriber is reached.

import { sb, testName, testPhone } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, customerCookie } from '../testkit/session'
import { makeCustomer, futureDateISO, testPictureUrl } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-managed-n3b'
const CITY = testName('city')

interface Body { ok?: boolean; error?: string; field?: string; reason?: string; event?: Record<string, unknown> & { id: string }; reservation_id?: string; booking?: { reservations: boolean; paid_tickets: boolean } }

async function messagesTo(phone: string): Promise<number> {
  const { count } = await sb.from('message_log').select('id', { count: 'exact', head: true }).like('to_number', `%${phone.replace('+', '')}%`)
  return count ?? 0
}

async function main(): Promise<void> {
  try {
    const admin = await adminCookie()
    const contact = testPhone(81, 9101)
    const base = { title: testName('n3b_event'), category: 'Concert', city: CITY, date: futureDateISO(6), time: '20:00', venue: 'Test Hall', cover_photo: testPictureUrl('photos'), price: 2000, whatsapp: contact }
    let eid = ''

    await step('create: poster and fields required; customer refused', async () => {
      // I1: no poster → created with the generated cover; a bad URL → 400.
      const noPic = await api<Body>('/api/admin/events', { cookie: admin, body: { ...base, title: testName('n3b_nopic'), cover_photo: '' } })
      assertEq(noPic.status, 200, 'no poster → created (generated cover)')
      if (noPic.body.event) track('events', noPic.body.event.id)
      assertEq(noPic.body.event?.cover_photo ?? null, null, 'cover_photo empty')
      const badPic = await api<Body>('/api/admin/events', { cookie: admin, body: { ...base, cover_photo: 'not-a-url' } })
      assertEq([badPic.status, badPic.body.field], [400, 'cover_photo'], 'bad poster URL → 400')
      const badCat = await api<Body>('/api/admin/events', { cookie: admin, body: { ...base, category: 'Nope' } })
      assertEq(badCat.status, 400, 'unknown category → 400')
      const cust = await makeCustomer({ suiteNo: 81, name: 'N3b Customer' })
      const r = await api<Body>('/api/admin/events', { cookie: customerCookie(cust), body: base })
      assertEq(r.status, 401, 'customer → 401')
    })

    await step('create → managed, published, no organiser, nobody messaged', async () => {
      const r = await api<Body>('/api/admin/events', { cookie: admin, body: base })
      assertEq(r.status, 200, `created (${r.raw.slice(0, 100)})`)
      eid = r.body.event!.id
      track('events', eid)
      const { data } = await sb.from('events').select('organizer_id, managed_by_platform, is_active, payment_mode, whatsapp, organizer_name').eq('id', eid).single()
      assertEq(data!.organizer_id, null, 'no organiser')
      assertEq(data!.managed_by_platform, true, 'managed')
      assertEq(data!.is_active, true, 'published')
      assertEq(data!.payment_mode, 'reservation_only', 'reservations only')
      assertEq(data!.organizer_name, 'Tchop & Ndjoka', 'shown as Tchop & Ndjoka')
      assertEq(await messagesTo(contact), 0, 'nobody messaged')
      const { data: a } = await sb.from('audit_log').select('id').eq('target_id', eid).eq('action', 'event_created_by_admin')
      assertEq((a ?? []).length, 1, 'audited')
    })

    await step('free reservations only: booking works, paid tickets refused', async () => {
      const av = await api<Body>(`/api/events/${eid}/availability`)
      assertEq(av.body.booking, { reservations: true, paid_tickets: false }, 'booking flags')
      const buyer = await makeCustomer({ suiteNo: 81, name: 'N3b Buyer', extra: { city: CITY } })
      const res = await api<Body>(`/api/events/${eid}/reserve`, { cookie: customerCookie(buyer), body: { quantity: 1, date: base.date } })
      if (res.body.reservation_id) track('event_reservations', res.body.reservation_id)
      assertEq(res.status, 200, `free reservation (${res.raw.slice(0, 100)})`)
      const pay = await api<Body>(`/api/events/${eid}/pay`, { cookie: customerCookie(buyer), body: { quantity: 1, phoneNumber: buyer.phone } })
      assertEq(pay.status, 403, `paid ticket refused (${pay.raw.slice(0, 80)})`)
      assertEq(pay.body.reason, 'module_off', 'module_off')
    })

    const bookings = testPhone(81, 9102)
    await step('bookings number: set, invalid refused, no message', async () => {
      const bad = await api<Body>(`/api/admin/events/${eid}/organizer`, { cookie: admin, body: { mode: 'notify', phone: '12' } })
      assertEq(bad.status, 400, 'invalid → 400')
      const r = await api<Body>(`/api/admin/events/${eid}/organizer`, { cookie: admin, body: { mode: 'notify', phone: bookings } })
      assertEq(r.status, 200, 'set')
      const { data } = await sb.from('events').select('notify_phone, managed_by_platform').eq('id', eid).single()
      assertEq([data!.notify_phone, data!.managed_by_platform], [bookings, true], 'stored, still managed')
      assertEq(await messagesTo(bookings), 0, 'no message on setting it')
    })

    await step('link organiser (new number) → organiser, not managed, their modules apply, no message', async () => {
      const orgPhone = testPhone(81, 9103)
      const noName = await api<Body>(`/api/admin/events/${eid}/organizer`, { cookie: admin, body: { mode: 'link', phone: orgPhone } })
      assertEq(noName.status, 400, 'new number without a name → 400')
      const r = await api<{ organizer?: { id: string } } & Body>(`/api/admin/events/${eid}/organizer`, { cookie: admin, body: { mode: 'link', phone: orgPhone, name: 'N3b Organiser' } })
      assertEq(r.status, 200, `linked (${r.raw.slice(0, 80)})`)
      const orgId = r.body.organizer!.id
      track('customers', orgId)
      const { data } = await sb.from('events').select('organizer_id, managed_by_platform, whatsapp, organizer_name').eq('id', eid).single()
      assertEq([data!.organizer_id, data!.managed_by_platform, data!.whatsapp], [orgId, false, orgPhone], 'organiser set')
      assertEq(data!.organizer_name, 'N3b Organiser', 'name follows the account')
      assertEq(await messagesTo(orgPhone), 0, 'no message')
      const av = await api<Body>(`/api/events/${eid}/availability`)
      assertEq(av.body.booking, { reservations: false, paid_tickets: false }, 'a new account has no modules yet')
      const again = await api<Body>(`/api/admin/events/${eid}/organizer`, { cookie: admin, body: { mode: 'link', phone: testPhone(81, 9104), name: 'X' } })
      assertEq(again.status, 409, 'already has an organiser → 409')
    })

    await step('old events with no organiser (not managed) keep every module', async () => {
      const { data: ev } = await sb.from('events').insert({
        title: testName('n3b_legacy'), category: 'Concert', city: CITY, date: futureDateISO(7), is_active: true,
        event_status: 'upcoming', organizer_id: null,
      }).select('id').single()
      track('events', ev!.id as string)
      const av = await api<Body>(`/api/events/${ev!.id}/availability`)
      assertEq(av.body.booking, { reservations: true, paid_tickets: true }, 'unchanged behaviour')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
