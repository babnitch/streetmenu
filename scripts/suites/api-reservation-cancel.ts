// P0 #4 — cancelling / rejecting an event reservation.
//
// What it pins:
//   - Customer cancel releases the seats on BOTH counters: events.tickets_sold
//     and the tier's sold_count (the tier used to stay "sold").
//   - Exactly once: a repeat cancel is a no-op 200, two concurrent cancels
//     release once, and cancelling a REJECTED booking is refused (it used to
//     release its seats a second time).
//   - Reject releases the tier too.
//   - A customer cannot cancel a PAID ticket (403, "contact the organiser");
//     the organizer can, and the audit flags needs_refund.
//   - Nobody can cancel while the MoMo payment is in flight (409).
//
// Seats are booked through the real /reserve API so the counters move
// exactly as in production. Event city is run-namespaced (no subscribers);
// WhatsApp goes to the local server's dummy Twilio credentials.

import { sb } from '../testkit/env'
import { assert, assertEq, assertIncludes, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeEvent, makeTier } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-reservation-cancel'

async function counters(eventId: string, tierId: string) {
  const [{ data: ev }, { data: t }] = await Promise.all([
    sb.from('events').select('tickets_sold').eq('id', eventId).single(),
    sb.from('event_ticket_tiers').select('sold_count').eq('id', tierId).single(),
  ])
  return { event: Number(ev?.tickets_sold ?? 0), tier: Number(t?.sold_count ?? 0) }
}

async function main(): Promise<void> {
  try {
    const organizer = await makeCustomer({ suiteNo: 62, name: 'Cancel organizer', extra: { event_auto_approve: false } })
    const booker    = await makeCustomer({ suiteNo: 62, name: 'Cancel booker' })
    const orgCookie = customerCookie(organizer)
    const bookCookie = customerCookie(booker)

    const ev   = await makeEvent({ organizerId: organizer.id, label: 'cancel_flow', isActive: true })
    const tier = await makeTier(ev.id, { name: 'VIP', price: 0, maxQuantity: 10 })

    const book = async (qty: number): Promise<string> => {
      const r = await api<{ reservation_ids?: string[] }>(`/api/events/${ev.id}/reserve`, {
        cookie: bookCookie, body: { items: [{ tier_id: tier.id, quantity: qty }] },
      })
      const id = r.body.reservation_ids?.[0]
      if (r.status !== 200 || !id) throw new Error(`reserve failed ${r.status} ${r.raw.slice(0, 200)}`)
      track('event_reservations', id)
      return id
    }
    const cancel = (resId: string, cookie: string) =>
      api<{ ok?: boolean; error?: string; ignored?: string }>(`/api/events/${ev.id}/reservations/${resId}/cancel`, { method: 'POST', cookie })

    await step('customer cancel releases event total AND tier', async () => {
      const id = await book(3)
      assertEq(await counters(ev.id, tier.id), { event: 3, tier: 3 }, 'booked: 3 / 3')
      const r = await cancel(id, bookCookie)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(await counters(ev.id, tier.id), { event: 0, tier: 0 }, 'released: 0 / 0')

      const again = await cancel(id, bookCookie)
      assertEq(again.status, 200, 'repeat cancel is a 200')
      assertEq(await counters(ev.id, tier.id), { event: 0, tier: 0 }, 'and releases nothing more')
    })

    await step('two concurrent cancels release once', async () => {
      const keep = await book(2)
      const id   = await book(4)
      assertEq(await counters(ev.id, tier.id), { event: 6, tier: 6 }, 'booked: 6 / 6')
      const [a, b] = await Promise.all([cancel(id, bookCookie), cancel(id, bookCookie)])
      // Whichever wins gets 200; the loser sees either the "already
      // cancelled" 200 or the "already changed" 409 — never a 500.
      const codes = [a.status, b.status].sort()
      assert(codes[0] === 200 && (codes[1] === 200 || codes[1] === 409), `one 200, the other 200/409 (${a.status}, ${b.status})`)
      assertEq(await counters(ev.id, tier.id), { event: 2, tier: 2 }, 'released exactly 4')
      await cancel(keep, bookCookie)
    })

    await step('reject releases the tier; cancelling a rejected booking is refused', async () => {
      const id = await book(2)
      const rej = await api(`/api/events/${ev.id}/reservations/${id}/reject`, { method: 'POST', cookie: orgCookie })
      assertEq(rej.status, 200, 'organizer reject → 200')
      assertEq(await counters(ev.id, tier.id), { event: 0, tier: 0 }, 'released: 0 / 0')
      const r = await cancel(id, orgCookie)
      assertEq(r.status, 409, 'cancel a rejected booking → 409')
      assertEq(await counters(ev.id, tier.id), { event: 0, tier: 0 }, 'no second release')
    })

    // Paid / in-flight rows: inserted directly (no PawaPay), seats held by hand.
    const insertHeld = async (payment_status: 'paid' | 'pending', qty: number): Promise<string> => {
      const { data, error } = await sb.from('event_reservations').insert({
        event_id: ev.id, customer_id: booker.id, customer_name: booker.name, customer_phone: booker.phone,
        quantity: qty, total_price: 0, payment_status, reservation_status: 'confirmed',
        tier_id: tier.id, tier_name: 'VIP', tier_price: 0,
      } as never).select('id').single()
      if (error || !data) throw new Error(`insert reservation: ${error?.message}`)
      const id = (data as { id: string }).id
      track('event_reservations', id)
      const c = await counters(ev.id, tier.id)
      await sb.from('events').update({ tickets_sold: c.event + qty } as never).eq('id', ev.id)
      await sb.from('event_ticket_tiers').update({ sold_count: c.tier + qty } as never).eq('id', tier.id)
      return id
    }

    await step('customer cannot cancel a paid ticket; the organizer can', async () => {
      const id = await insertHeld('paid', 2)
      const r = await cancel(id, bookCookie)
      assertEq(r.status, 403, 'customer → 403')
      assertIncludes(r.body.error, 'Contact the organiser to cancel a paid ticket', 'tells them to contact the organiser')
      assertEq(await counters(ev.id, tier.id), { event: 2, tier: 2 }, 'nothing released')

      const o = await cancel(id, orgCookie)
      assertEq(o.status, 200, `organizer → 200 (body ${o.raw.slice(0, 160)})`)
      assertEq(await counters(ev.id, tier.id), { event: 0, tier: 0 }, 'released')
      const { data: audit } = await sb.from('audit_log').select('metadata')
        .eq('action', 'event_reservation_cancelled').eq('target_id', id).maybeSingle()
      assertEq((audit?.metadata as { needs_refund?: boolean } | null)?.needs_refund, true, 'audit flags needs_refund')
    })

    await step('no cancel while the MoMo payment is in flight', async () => {
      const id = await insertHeld('pending', 1)
      const r = await cancel(id, orgCookie)
      assertEq(r.status, 409, 'organizer → 409')
      const { data: row } = await sb.from('event_reservations').select('reservation_status').eq('id', id).single()
      assertEq(row?.reservation_status, 'confirmed', 'row untouched')
      assertEq(await counters(ev.id, tier.id), { event: 1, tier: 1 }, 'seats still held')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
