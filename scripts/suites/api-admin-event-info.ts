// Admin « Infos de l'événement » (GET/PUT /api/admin/events/[id]/info,
// lib/eventEdit.ts):
//   - admin / super admin only (organiser, moderator, customer → 401)
//   - works on a managed event and on an organiser's event
//   - the organiser form's checks: city we serve, pin in the city, end after
//     start, paid tickets need the module, https link only
//   - one event_info_changed audit row with old → new
//   - an event with bookings: notify false → nobody told (not_sent in the
//     event_updated row); the organiser PATCH still works
//   - « infos seulement » refused while people have booked
//   - a rejected (deleted) event can't be edited

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, customerCookie, staffCookie } from '../testkit/session'
import { makeCustomer, makeEvent, futureDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { acceptEventPin, checkInfoLink } from '@/lib/eventEdit'
import { getRefData } from '@/lib/refDataServer'

const SUITE = 'api-admin-event-info'

interface Body { error?: string; field?: string; updated?: boolean; notified_count?: number; changed?: string[]; bookings?: number; pin_ready?: boolean; event?: Record<string, unknown> }

async function main(): Promise<void> {
  try {
    const admin = await adminCookie()
    const url = (id: string) => `/api/admin/events/${id}/info`
    const put = (id: string, body: Record<string, unknown>, cookie = admin) => api<Body>(url(id), { method: 'PUT', cookie, body })

    // Organiser without the paid_tickets module.
    const organiser = await makeCustomer({ name: 't_info_org', extra: { organizer_modules: ['reservations'] } })
    const orgEvent = await makeEvent({ organizerId: organiser.id, label: 'info_org', isActive: true, date: futureDateISO(20), ticketPrice: 0 })
    const managed = await makeEvent({ organizerId: organiser.id, label: 'info_managed', isActive: true, date: futureDateISO(21),
      extra: { organizer_id: null, managed_by_platform: true, booking_mode: 'info' } })

    await step('admin only', async () => {
      assertEq((await api(url(orgEvent.id))).status, 401, 'no session → 401')
      assertEq((await api(url(orgEvent.id), { cookie: customerCookie(organiser) })).status, 401, 'the organiser → 401')
      const mod = staffCookie({ id: organiser.id, email: 'mod@test.invalid', name: 'mod', role: 'moderator' })
      assertEq((await put(orgEvent.id, { title: 'x' }, mod)).status, 401, 'moderator → 401')
      const g = await api<Body>(url(orgEvent.id), { cookie: admin })
      assertEq(g.status, 200, 'admin GET → 200')
      assertEq(g.body.bookings, 0, 'no bookings yet')
      assertEq(g.body.event?.title, orgEvent.title, 'current values')
    })

    await step('organiser event: details saved, audited old → new', async () => {
      const newTitle = testName('info_org_renamed')
      const r = await put(orgEvent.id, {
        title: newTitle, description: 'Nouvelle description', venue: 'Salle A', neighborhood: 'Akwa',
        date: futureDateISO(22), time: '20:00', end_date: futureDateISO(23), end_time: '02:00',
        ticket_price: 5000, price_is_from: true, info_link: 'https://ayatickets.fr/e/1', whatsapp: '+237699000111', notify_phone: '+237699000222',
      })
      assertEq(r.status, 200, `PUT → 200 (${r.body.error ?? ''})`)
      const { data: e } = await sb.from('events').select('title, venue, end_date, ticket_price, price, price_is_from, info_link, whatsapp, notify_phone').eq('id', orgEvent.id).single()
      assertEq(e?.title, newTitle, 'title')
      assertEq([e?.venue, e?.end_date, e?.ticket_price, e?.price, e?.price_is_from], ['Salle A', futureDateISO(23), 5000, 5000, true], 'venue, multi-day end, price kept in sync, « À partir de »')
      assertEq([e?.info_link, e?.whatsapp, e?.notify_phone], ['https://ayatickets.fr/e/1', '+237699000111', '+237699000222'], 'link and numbers')
      const { data: audit } = await sb.from('audit_log').select('metadata, previous_data, performed_by_type').eq('target_id', orgEvent.id).eq('action', 'event_info_changed')
      assertEq(audit?.length, 1, 'one event_info_changed row')
      const ch = (audit?.[0]?.metadata as { changes?: Record<string, { old: unknown; new: unknown }> })?.changes ?? {}
      assertEq(ch.title, { old: orgEvent.title, new: newTitle }, 'title old → new')
      assertEq(ch.ticket_price, { old: 0, new: 5000 }, 'price old → new')
      assert(!('price' in ch), 'derived column not repeated')
      assertEq(audit?.[0]?.performed_by_type, 'super_admin', 'performed by the admin')
    })

    await step('managed event: booking mode + info link', async () => {
      const r = await put(managed.id, { booking_mode: 'platform', info_link: '' })
      assertEq(r.status, 200, `PUT → 200 (${r.body.error ?? ''})`)
      const { data: e } = await sb.from('events').select('booking_mode, info_link').eq('id', managed.id).single()
      assertEq([e?.booking_mode, e?.info_link], ['platform', null], 'switched to bookings, link cleared')
    })

    await step('the organiser form checks', async () => {
      const city = await put(orgEvent.id, { city: 'Paris' })
      assertEq([city.status, city.body.field], [400, 'city'], 'a city we don\'t serve → 400')
      const range = await put(orgEvent.id, { date: futureDateISO(25), end_date: futureDateISO(24) })
      assertEq(range.status, 400, 'end before start → 400')
      const link = await put(orgEvent.id, { info_link: 'javascript:alert(1)' })
      assertEq([link.status, link.body.field], [400, 'info_link'], 'non-http link → 400')
      const pin = await put(orgEvent.id, { lat: 48.85, lng: 2.35 })
      assertEq([pin.status, pin.body.field], [400, 'lat'], 'pin outside the city (or not yet available) → 400')
      const mode = await put(orgEvent.id, { booking_mode: 'other' })
      assertEq([mode.status, mode.body.field], [400, 'booking_mode'], 'unknown booking mode → 400')
      const paid = await put(orgEvent.id, { payment_mode: 'both' })
      assertEq(paid.status, 403, 'paid tickets without the module → 403 (admin panel too)')
      await getRefData()
      assert(!!acceptEventPin('Douala', 4.05, 9.7), 'a Douala pin is in Douala')
      assertEq(acceptEventPin('Douala', 3.848, 11.502), null, 'a Yaoundé pin is not in Douala')
      assertEq([checkInfoLink('https://x.cm').ok, checkInfoLink('ftp://x').ok, checkInfoLink('').ok], [true, false, true], 'link rule')
    })

    await step('bookings: the admin chooses whether to tell them', async () => {
      const booker = await makeCustomer({ name: 't_info_booker' })
      const ev = await makeEvent({ organizerId: organiser.id, label: 'info_booked', isActive: true, date: futureDateISO(26), extra: { booking_mode: 'platform' } })
      const { data: res, error } = await sb.from('event_reservations').insert({
        event_id: ev.id, customer_id: booker.id, customer_name: booker.name, customer_phone: booker.phone, quantity: 1,
        event_date: futureDateISO(26), reservation_status: 'confirmed',
      } as never).select('id').single()
      if (error || !res) throw new Error(`insert reservation: ${error?.message}`)
      track('event_reservations', (res as { id: string }).id)

      assertEq((await api<Body>(url(ev.id), { cookie: admin })).body.bookings, 1, 'GET counts the booking')
      const r = await put(ev.id, { date: futureDateISO(27), venue: 'Nouvelle salle', notify: false })
      assertEq(r.status, 200, `move without telling → 200 (${r.body.error ?? ''})`)
      assertEq(r.body.notified_count, 0, 'nobody told')
      const { data: moved } = await sb.from('event_reservations').select('event_date').eq('id', (res as { id: string }).id).single()
      assertEq(moved?.event_date, futureDateISO(27), 'the single-day booking moved with the event')
      const { data: upd } = await sb.from('audit_log').select('metadata').eq('target_id', ev.id).eq('action', 'event_updated')
      assert((upd ?? []).some(a => (a.metadata as { not_sent?: boolean })?.not_sent === true), 'event_updated row says not sent')

      const info = await put(ev.id, { booking_mode: 'info' })
      assertEq([info.status, info.body.field], [409, 'booking_mode'], '« infos seulement » refused while people have booked')
    })

    await step('rejected event → 404', async () => {
      const ev = await makeEvent({ organizerId: organiser.id, label: 'info_rejected', isActive: false, extra: { event_status: 'rejected' } })
      assertEq((await api(url(ev.id), { cookie: admin })).status, 404, 'GET → 404')
      assertEq((await put(ev.id, { title: 'x' })).status, 404, 'PUT → 404')
      assertEq((await api(`/api/events/${ev.id}`, { method: 'PATCH', cookie: customerCookie(organiser), body: { title: 'x' } })).status, 404, 'organiser PATCH → 404')
    })

    await step('organiser PATCH still works (shared rules)', async () => {
      const r = await api<Body>(`/api/events/${orgEvent.id}`, { method: 'PATCH', cookie: customerCookie(organiser), body: { description: 'Par l\'organisateur', booking_mode: 'info' } })
      assertEq(r.status, 200, `PATCH → 200 (${r.body.error ?? ''})`)
      const { data: e } = await sb.from('events').select('description, booking_mode').eq('id', orgEvent.id).single()
      assertEq(e?.description, 'Par l\'organisateur', 'description saved')
      assert(e?.booking_mode !== 'info', 'booking mode stays admin-only')
      const { data: audit } = await sb.from('audit_log').select('performed_by_type').eq('target_id', orgEvent.id).eq('action', 'event_info_changed').eq('performed_by_type', 'organiser')
      assertEq(audit?.length, 1, 'organiser edit audited too')
    })
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
