// Q4 — door staff: the organiser (or an admin, for a managed event) adds a
// phone to ONE event; that person can scan / check in its tickets and
// nothing else — not another event, not the guest list, not the organiser's
// actions. One WhatsApp when added. Removing ends the access at once.
//
// Every phone is +999; per-run city; never approved from pending.

import { sb, testName, testPhone } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeEvent } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { ensureScanToken } from '../../lib/scanTokens'
import { dateInZone } from '../../lib/offers'

const SUITE = 'api-door-staff-q4'
const CITY = testName('city')

interface View { access?: string; action?: string; error?: string; staff?: Array<{ customer_id: string; phone: string; name: string }>; events?: Array<{ id: string }> }

async function main(): Promise<void> {
  try {
    const today = dateInZone('Africa/Douala')
    const org = await makeCustomer({ suiteNo: 87, name: 'Q4 Organiser', extra: { default_mode: 'pro' } })
    const buyer = await makeCustomer({ suiteNo: 87, name: 'Q4 Buyer', extra: { city: CITY } })
    const stranger = await makeCustomer({ suiteNo: 87, name: 'Q4 Stranger' })
    const oc = customerCookie(org)
    const ev = await makeEvent({ organizerId: org.id, label: 'q4_event', isActive: true, date: today, city: CITY })
    const other = await makeEvent({ organizerId: org.id, label: 'q4_other', isActive: true, date: today, city: CITY })
    const book = async (eventId: string) => {
      const r = await api<{ reservation_ids?: string[] }>(`/api/events/${eventId}/reserve`, { cookie: customerCookie(buyer), body: { quantity: 1 } })
      for (const id of r.body.reservation_ids ?? []) track('event_reservations', id)
      return r.body.reservation_ids![0]
    }
    const doorPhone = testPhone(87, 9101)
    let door: { id: string; cookie: string } = { id: '', cookie: '' }

    await step('only the organiser (or an admin) adds door staff; one WhatsApp', async () => {
      assertEq((await api(`/api/events/${ev.id}/door-staff`, { cookie: customerCookie(stranger), body: { phone: doorPhone } })).status, 403, 'stranger → 403')
      const r = await api<View>(`/api/events/${ev.id}/door-staff`, { cookie: oc, body: { phone: doorPhone } })
      assertEq(r.status, 200, `added (${r.raw.slice(0, 80)})`)
      const s = r.body.staff?.find(x => x.phone === doorPhone)
      assert(!!s, 'listed')
      door = { id: s!.customer_id, cookie: customerCookie({ id: s!.customer_id, phone: doorPhone, name: s!.name } as never) }
      track('customers', door.id)
      await sb.from('customers').update({ default_mode: 'pro' }).eq('id', door.id)   // door staff validate in Pro mode
      const { data } = await sb.from('message_log').select('body').like('to_number', `%${doorPhone.replace('+', '')}%`)
      assertEq(data?.length, 1, 'one WhatsApp')
      assert(String(data?.[0]?.body).includes(`/scanner?event=${ev.id}`), 'with the scanner link')
      assertEq((await api(`/api/events/${ev.id}/door-staff`, { cookie: oc, body: { phone: doorPhone } })).status, 409, 'twice → 409')
      const mine = await api<View>('/api/scan/my-events', { cookie: door.cookie })
      assert((mine.body.events ?? []).some(e => e.id === ev.id), 'their ☰ / scanner list has the event')
    })

    await step('door staff check in THIS event only', async () => {
      const t = await ensureScanToken('reservation', await book(ev.id))
      const v = await api<View>(`/api/scan/${t}`, { cookie: door.cookie })
      assertEq([v.body.access, v.body.action], ['staff', 'checkin'], 'button')
      assertEq((await api(`/api/scan/${t}`, { method: 'POST', cookie: door.cookie, body: {} })).status, 200, 'checked in')
      const t2 = await ensureScanToken('reservation', await book(other.id))
      assertEq((await api<View>(`/api/scan/${t2}`, { cookie: door.cookie })).body.access, 'none', 'another event → neutral')
      assertEq((await api(`/api/scan/${t2}`, { method: 'POST', cookie: door.cookie, body: {} })).status, 403, 'and can\'t check in')
    })

    await step('nothing else: no guest list, no organiser actions, no adding staff', async () => {
      assertEq((await api(`/api/events/${ev.id}/reservations`, { cookie: door.cookie })).status, 403, 'guest list → 403')
      assertEq((await api(`/api/events/${ev.id}/door-staff`, { cookie: door.cookie })).status, 403, 'staff list → 403')
      assertEq((await api(`/api/events/${ev.id}/door-staff`, { cookie: door.cookie, body: { phone: testPhone(87, 9102) } })).status, 403, 'add staff → 403')
    })

    await step('removed → access ends at once', async () => {
      assertEq((await api(`/api/events/${ev.id}/door-staff`, { method: 'DELETE', cookie: oc, body: { customer_id: door.id } })).status, 200, 'removed')
      const t = await ensureScanToken('reservation', await book(ev.id))
      assertEq((await api<View>(`/api/scan/${t}`, { cookie: door.cookie })).body.access, 'none', 'no access any more')
    })

    await step('managed event: an admin adds door staff', async () => {
      const { data: m } = await sb.from('events').insert({
        title: testName('q4_managed'), category: 'Autre', city: CITY, date: today, is_active: true, event_status: 'upcoming',
        organizer_id: null, managed_by_platform: true,
      }).select('id').single()
      track('events', m!.id as string)
      const admin = await adminCookie()
      const r = await api<View>(`/api/events/${m!.id}/door-staff`, { cookie: admin, body: { phone: doorPhone, name: 'Door' } })
      assertEq(r.status, 200, `admin added (${r.raw.slice(0, 60)})`)
      const t = await ensureScanToken('reservation', await book(m!.id as string))
      assertEq((await api(`/api/scan/${t}`, { method: 'POST', cookie: door.cookie, body: {} })).status, 200, 'door staff checks in on a managed event')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
