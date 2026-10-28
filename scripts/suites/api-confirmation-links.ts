// Customer confirmations end with a website link, in the same message:
// order received → Mon compte › commandes; booking confirmed → réservations.
// Every phone is +999; events use a per-run city.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, makeEvent } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-confirmation-links'

async function bodiesTo(phone: string, relatedId: string): Promise<string[]> {
  const { data } = await sb.from('message_log').select('body').eq('related_id', relatedId).like('to_number', `%${phone.replace('+', '')}%`)
  return (data ?? []).map(r => String(r.body))
}

async function main(): Promise<void> {
  try {
    const buyer = await makeCustomer({ suiteNo: 77, name: 'Links Buyer' })
    const rest = await makeRestaurant({ label: 'links_r' })

    await step('order received → link to my orders, one message', async () => {
      const o = await makeOrder(rest.id, buyer, { status: 'pending' })
      const r = await api('/api/whatsapp/notify-order', { cookie: customerCookie(buyer), body: { orderId: o.id } })
      assertEq(r.status, 200, 'notify-order 200')
      const b = await bodiesTo(buyer.phone, o.id)
      assertEq(b.length, 1, 'one message to the customer')
      assert(b[0]?.includes('/account?tab=orders'), 'ends with the orders link')
    })

    await step('booking confirmed → link to my bookings, one message', async () => {
      const ev = await makeEvent({ label: 'links_event', isActive: true })
      const r = await api<{ reservation_id?: string }>(`/api/events/${ev.id}/reserve`, { cookie: customerCookie(buyer), body: { quantity: 1 } })
      if (r.body.reservation_id) track('event_reservations', r.body.reservation_id)
      assertEq(r.status, 200, `reserve 200 (${r.raw.slice(0, 100)})`)
      const b = await bodiesTo(buyer.phone, ev.id)
      assertEq(b.length, 1, 'one message to the customer')
      assert(b[0]?.includes('/account?tab=bookings'), 'ends with the bookings link')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
