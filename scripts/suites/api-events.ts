// TEST-PLAN.md §1c #34 — the event lifecycle.
// (#35 tiers and #36 vouchers land as separate commits.)
//
// 🔴 SAFETY. Publishing an event fans WhatsApp out to REAL subscribers whose
// subscription matches the event's city + category, and nothing can un-send
// that message. This database has live subscribers, so the hazard is armed,
// not hypothetical. Three interlocks, all of which must hold:
//
//   1. Every event uses a RUN-NAMESPACED city (__t_<RUN_ID>_city__), the
//      fixtures' default. lib/subscriptions.findMatchingSubscribers filters
//      `.eq('city', city)` — an exact match — so a per-run unique string has
//      zero subscribers BY CONSTRUCTION rather than by observation.
//   2. Every organizer is created with event_auto_approve: false explicitly.
//      app/api/events/submit/route.ts:185 fans out AT SUBMIT TIME when that
//      flag is true, bypassing the admin approve route entirely. That is a
//      second door, and the column default is not something to trust.
//   3. assertNoSubscribers() runs immediately before EVERY approve and
//      ABORTS THE WHOLE SUITE if the count is anything but zero. Not a warn,
//      not a skip — a test that messages a real person is a failed test.
//
// Interlock 3 is deliberately redundant with 1 and 2. If a future change to
// the fixtures quietly reintroduces a real city, this is what stops the send.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeEvent, futureDateISO, pastDateISO, type TestCustomer } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { countMatchingSubscribers } from '@/lib/subscriptions'

const SUITE = 'api-events'

// The city every event in this suite uses. Unique per run.
const TEST_CITY = testName('city')
const TEST_CATEGORY = 'Autre'

interface ReserveBody {
  ok?: boolean
  error?: string
  reservations?: Array<{ id: string; reservation_code: string; quantity: number }>
  reservation?: { id: string; reservation_code?: string }
  remaining?: number
}
interface EventRow {
  id: string; is_active: boolean; tickets_sold: number | null
  max_tickets: number | null; requires_confirmation: boolean | null
}

// Hard abort. Throwing out of main() skips the rest of the suite; the finally
// block still tears down, so we never leave rows behind on the way out.
class SubscriberSafetyError extends Error {}

async function assertNoSubscribers(city: string, category: string): Promise<void> {
  const n = await countMatchingSubscribers({ city, category })
  if (n !== 0) {
    throw new SubscriberSafetyError(
      `ABORTING: ${n} real subscriber(s) match city=${JSON.stringify(city)} category=${JSON.stringify(category)}. ` +
      'Approving would send them WhatsApp messages that cannot be recalled. ' +
      'Fix the test city before running this suite again.',
    )
  }
  assert(true, `pre-approve safety: 0 subscribers for ${JSON.stringify(city)} / ${category}`)
}

async function readEvent(id: string): Promise<EventRow | null> {
  const { data } = await sb.from('events')
    .select('id, is_active, tickets_sold, max_tickets, requires_confirmation')
    .eq('id', id).maybeSingle()
  return data as EventRow | null
}

async function reservationRows(eventId: string) {
  const { data } = await sb.from('event_reservations')
    .select('id, reservation_status, quantity, reservation_code, customer_id, tier_id')
    .eq('event_id', eventId).order('created_at', { ascending: true })
  return (data ?? []) as Array<{
    id: string; reservation_status: string; quantity: number
    reservation_code: string | null; customer_id: string; tier_id: string | null
  }>
}

async function main(): Promise<void> {
  try {
    // Safety gate before anything at all — if the namespaced city somehow has
    // subscribers, nothing in this suite should run.
    await step('🔴 safety preflight: the test city has no real subscribers', async () => {
      for (const cat of [TEST_CATEGORY, 'Concert', 'Festival']) {
        await assertNoSubscribers(TEST_CITY, cat)
      }
    })

    const organizer = await makeCustomer({
      suiteNo: 34, name: 'Event Organizer',
      extra: { event_auto_approve: false },   // interlock 2
    })
    const booker  = await makeCustomer({ suiteNo: 34, name: 'Event Booker' })
    const booker2 = await makeCustomer({ suiteNo: 34, name: 'Second Booker' })
    const orgCookie    = customerCookie(organizer)
    const bookerCookie = customerCookie(booker)
    const admin = await adminCookie()

    const submitEvent = (body: Record<string, unknown>, cookie: string | null) =>
      api<{ ok?: boolean; event_id?: string; auto_approved?: boolean; error?: string }>('/api/events/submit', {
        method: 'POST', body, ...(cookie ? { cookie } : {}),
      })
    const approve = (id: string, cookie: string) =>
      api(`/api/admin/events/${id}/approve`, { method: 'POST', cookie })
    const reserve = (id: string, body: Record<string, unknown>, cookie: string | null) =>
      api<ReserveBody>(`/api/events/${id}/reserve`, { method: 'POST', body, ...(cookie ? { cookie } : {}) })

    // ── SUBMIT → pending ───────────────────────────────────────────────────
    let submittedId = ''
    await step('#34 a non-auto-approve organizer submits → pending, NOT published', async () => {
      const r = await submitEvent({
        title: testName('submitted'),
        date: futureDateISO(30),
        city: TEST_CITY,
        category: TEST_CATEGORY,
        whatsapp: organizer.phone,
        ticket_price: 0,
      }, orgCookie)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 180)})`)
      submittedId = r.body.event_id ?? ''
      assert(!!submittedId, 'an event id came back')
      track('events', submittedId)
      assertEq(r.body.auto_approved, false, 'auto_approved=false in the response')

      const ev = await readEvent(submittedId)
      assertEq(ev?.is_active, false, 'is_active=false — it is pending, not published')

      // Interlock 2 proven from the outside: a non-auto-approve organizer
      // must not have triggered the submit-time fan-out.
      const { data: org } = await sb.from('customers')
        .select('event_auto_approve').eq('id', organizer.id).maybeSingle()
      assertEq((org as { event_auto_approve?: boolean } | null)?.event_auto_approve, false,
        'the organizer really is not auto-approve, so submit could not have fanned out')
    })

    await step('#34 submit requires a login and the mandatory fields', async () => {
      assertEq((await submitEvent({ title: 'x', date: futureDateISO(5), city: TEST_CITY,
        category: TEST_CATEGORY, whatsapp: organizer.phone }, null)).status, 401, 'no session → 401')
      assertEq((await submitEvent({ date: futureDateISO(5), city: TEST_CITY,
        category: TEST_CATEGORY, whatsapp: organizer.phone }, orgCookie)).status, 400, 'missing title → 400')
      assertEq((await submitEvent({ title: 'x', city: TEST_CITY,
        category: TEST_CATEGORY, whatsapp: organizer.phone }, orgCookie)).status, 400, 'missing date → 400')
    })

    // ── ADMIN APPROVE → active ─────────────────────────────────────────────
    await step('#34 admin approve publishes the event', async () => {
      await assertNoSubscribers(TEST_CITY, TEST_CATEGORY)   // interlock 3
      const r = await approve(submittedId, admin)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)

      const ev = await readEvent(submittedId)
      assertEq(ev?.is_active, true, 'is_active=true — now published')

      const { data } = await sb.from('audit_log').select('action')
        .eq('target_id', submittedId).eq('action', 'event_approved').limit(1).maybeSingle()
      assert(!!data, 'an event_approved audit row was written')

      // The fan-out writes this audit row only when it actually sent to
      // someone. Its absence is independent proof nobody was messaged.
      const { data: fanout } = await sb.from('audit_log').select('action')
        .eq('target_id', submittedId).eq('action', 'event_notification_sent').maybeSingle()
      assertEq(fanout, null, 'NO event_notification_sent row — nobody was messaged')
    })

    await step('#34 approve is admin-only', async () => {
      const ev = await makeEvent({ organizerId: organizer.id, label: 'authz', city: TEST_CITY, category: TEST_CATEGORY })
      assertEq((await approve(ev.id, bookerCookie)).status, 401, 'a customer session → 401')
      assertEq((await api(`/api/admin/events/${ev.id}/approve`, { method: 'POST' })).status, 401,
        'no session → 401')
      assertEq((await readEvent(ev.id))?.is_active, false, 'and it stays unpublished')
    })

    // ── RESERVE ────────────────────────────────────────────────────────────
    await step('#34 reserving creates a row with a code and bumps tickets_sold', async () => {
      const before = await readEvent(submittedId)
      assertEq(before?.tickets_sold ?? 0, 0, 'starts at zero sold')

      const r = await reserve(submittedId, { quantity: 3 }, bookerCookie)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 200)})`)

      const rows = await reservationRows(submittedId)
      assertEq(rows.length, 1, 'exactly one reservation row')
      for (const row of rows) track('event_reservations', row.id)
      assertEq(rows[0]?.quantity, 3, 'quantity recorded')
      assert(!!rows[0]?.reservation_code, 'a reservation_code was generated')
      assertEq(rows[0]?.reservation_code?.length, 4, 'the code is 4 characters')
      assertEq(rows[0]?.customer_id, booker.id, 'attached to the booking account')
      assertEq(rows[0]?.reservation_status, 'confirmed',
        'confirmed straight away — this event does not require confirmation')

      const after = await readEvent(submittedId)
      assertEq(after?.tickets_sold, 3, 'tickets_sold incremented BY THE QUANTITY, not by one')
    })

    await step('#34 reserving requires a customer session', async () => {
      const r = await reserve(submittedId, { quantity: 1 }, null)
      assertEq(r.status, 401, 'no session → 401')
      assert((r.body as { login_required?: boolean }).login_required === true,
        'and the body flags login_required for the client')
    })

    await step('#34 an organizer cannot book their own event', async () => {
      const r = await reserve(submittedId, { quantity: 1 }, orgCookie)
      assertEq(r.status, 403, 'self-booking → 403')
      assertEq((await readEvent(submittedId))?.tickets_sold, 3, 'and tickets_sold is unchanged')
    })

    // ── CANCEL restores the counter ────────────────────────────────────────
    await step('#34 cancelling a reservation releases the seats', async () => {
      const rows = await reservationRows(submittedId)
      const res = rows.find(r => r.reservation_status === 'confirmed')!
      const before = await readEvent(submittedId)

      const r = await api(`/api/events/${submittedId}/reservations/${res.id}/cancel`, {
        method: 'POST', cookie: bookerCookie,
      })
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)

      const after = await readEvent(submittedId)
      assertEq(after?.tickets_sold, (before?.tickets_sold ?? 0) - res.quantity,
        'tickets_sold goes back down by the cancelled quantity')
      const updated = (await reservationRows(submittedId)).find(x => x.id === res.id)
      assertEq(updated?.reservation_status, 'cancelled', "the row is marked 'cancelled'")

      // Documented as idempotent.
      const again = await api(`/api/events/${submittedId}/reservations/${res.id}/cancel`, {
        method: 'POST', cookie: bookerCookie,
      })
      assertEq(again.status, 200, 'cancelling twice is a 200')
      assertEq((await readEvent(submittedId))?.tickets_sold, after?.tickets_sold,
        'and does NOT release the seats a second time')
    })

    // ── requires_confirmation: confirm and reject ──────────────────────────
    await step('#34 requires_confirmation holds a booking as pending', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'needs_confirm', city: TEST_CITY, category: TEST_CATEGORY,
        isActive: true, extra: { requires_confirmation: true },
      })
      const r = await reserve(ev.id, { quantity: 2 }, bookerCookie)
      assertEq(r.status, 200, 'the reservation is accepted')

      const rows = await reservationRows(ev.id)
      for (const row of rows) track('event_reservations', row.id)
      assertEq(rows[0]?.reservation_status, 'pending', "held as 'pending', awaiting the organizer")
      assertEq((await readEvent(ev.id))?.tickets_sold, 2,
        'the seats are held immediately — capacity is reserved while pending')

      // Confirm.
      const conf = await api(`/api/events/${ev.id}/reservations/${rows[0].id}/confirm`, {
        method: 'POST', cookie: orgCookie,
      })
      assertEq(conf.status, 200, 'organizer confirm → 200')
      assertEq((await reservationRows(ev.id))[0]?.reservation_status, 'confirmed', "now 'confirmed'")
      assertEq((await readEvent(ev.id))?.tickets_sold, 2, 'confirming does not change the counter')

      // Re-confirming is a harmless no-op: the 409 guard fires only for
      // 'cancelled' or 'rejected', not for anything non-pending.
      const twice = await api(`/api/events/${ev.id}/reservations/${rows[0].id}/confirm`, {
        method: 'POST', cookie: orgCookie,
      })
      assertEq(twice.status, 200, 'confirming an already-confirmed reservation is idempotent → 200')
      assertEq((await reservationRows(ev.id))[0]?.reservation_status, 'confirmed', 'still confirmed')

      // A CANCELLED reservation is what the 409 guard actually protects.
      await api(`/api/events/${ev.id}/reservations/${rows[0].id}/cancel`, { method: 'POST', cookie: orgCookie })
      const afterCancel = await api(`/api/events/${ev.id}/reservations/${rows[0].id}/confirm`, {
        method: 'POST', cookie: orgCookie,
      })
      assertEq(afterCancel.status, 409, 'confirming a cancelled reservation → 409')
    })

    await step('#34 rejecting a pending booking releases its seats', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'reject_flow', city: TEST_CITY, category: TEST_CATEGORY,
        isActive: true, extra: { requires_confirmation: true },
      })
      const r = await reserve(ev.id, { quantity: 4 }, bookerCookie)
      assertEq(r.status, 200, 'the reservation is accepted')
      const rows = await reservationRows(ev.id)
      for (const row of rows) track('event_reservations', row.id)
      assertEq((await readEvent(ev.id))?.tickets_sold, 4, 'seats held while pending')

      const rej = await api(`/api/events/${ev.id}/reservations/${rows[0].id}/reject`, {
        method: 'POST', cookie: orgCookie,
      })
      assertEq(rej.status, 200, 'organizer reject → 200')
      assertEq((await reservationRows(ev.id))[0]?.reservation_status, 'rejected', "marked 'rejected'")
      assertEq((await readEvent(ev.id))?.tickets_sold, 0,
        'and the seats go back into the pool')
    })

    await step('#34 confirm/reject/attend are organizer-only', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'res_authz', city: TEST_CITY, category: TEST_CATEGORY,
        isActive: true, extra: { requires_confirmation: true },
      })
      await reserve(ev.id, { quantity: 1 }, bookerCookie)
      const rows = await reservationRows(ev.id)
      for (const row of rows) track('event_reservations', row.id)
      const resId = rows[0].id

      const strangerCookie = customerCookie(booker2)
      for (const action of ['confirm', 'reject', 'attend']) {
        assertEq((await api(`/api/events/${ev.id}/reservations/${resId}/${action}`,
          { method: 'POST', cookie: strangerCookie })).status, 403, `${action}: a stranger → 403`)
        assertEq((await api(`/api/events/${ev.id}/reservations/${resId}/${action}`,
          { method: 'POST' })).status, 401, `${action}: no session → 401`)
      }
      assertEq((await reservationRows(ev.id))[0]?.reservation_status, 'pending',
        'the reservation survived every refusal')
    })

    // ── ATTEND ─────────────────────────────────────────────────────────────
    await step('#34 a confirmed reservation can be marked attended', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'attend_flow', city: TEST_CITY, category: TEST_CATEGORY,
        isActive: true,
      })
      await reserve(ev.id, { quantity: 1 }, bookerCookie)
      const rows = await reservationRows(ev.id)
      for (const row of rows) track('event_reservations', row.id)
      assertEq(rows[0]?.reservation_status, 'confirmed', 'starts confirmed')

      const r = await api(`/api/events/${ev.id}/reservations/${rows[0].id}/attend`, {
        method: 'POST', cookie: orgCookie,
      })
      assertEq(r.status, 200, 'organizer attend → 200')
      assertEq((await reservationRows(ev.id))[0]?.reservation_status, 'attended', "marked 'attended'")
    })

    // ── PAST EVENT ─────────────────────────────────────────────────────────
    await step('#34 a past event refuses new bookings', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'past_event', city: TEST_CITY, category: TEST_CATEGORY,
        isActive: true, date: pastDateISO(3),
      })
      const r = await reserve(ev.id, { quantity: 1 }, bookerCookie)
      assertEq(r.status, 409, 'HTTP 409')
      assert((r.body.error ?? '').toLowerCase().includes('pass'), 'the error says the event has passed')
      assertEq((await reservationRows(ev.id)).length, 0, 'no reservation row was created')
      assertEq((await readEvent(ev.id))?.tickets_sold ?? 0, 0, 'and tickets_sold is untouched')
    })

    await step('#34 an unpublished event refuses bookings', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'unpublished', city: TEST_CITY, category: TEST_CATEGORY,
        isActive: false,
      })
      const r = await reserve(ev.id, { quantity: 1 }, bookerCookie)
      assertEq(r.status, 403, 'HTTP 403 — not published')
      assertEq((await reservationRows(ev.id)).length, 0, 'no reservation row')
    })

    // ── CAPACITY ───────────────────────────────────────────────────────────
    await step('#34 capacity exhaustion refuses the booking that would overflow', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'capacity', city: TEST_CITY, category: TEST_CATEGORY,
        isActive: true, maxTickets: 5,
      })

      const ok = await reserve(ev.id, { quantity: 4 }, bookerCookie)
      assertEq(ok.status, 200, 'booking 4 of 5 succeeds')
      for (const row of await reservationRows(ev.id)) track('event_reservations', row.id)
      assertEq((await readEvent(ev.id))?.tickets_sold, 4, 'four sold')

      // 4 + 2 > 5 — refused, and refused whole rather than partially filled.
      const over = await reserve(ev.id, { quantity: 2 }, customerCookie(booker2))
      assertEq(over.status, 409, 'the booking that would overflow → 409')
      assertEq(over.body.remaining, 1, 'and the response reports how many are left')
      assertEq((await readEvent(ev.id))?.tickets_sold, 4, 'tickets_sold unchanged by the refusal')
      assertEq((await reservationRows(ev.id)).length, 1, 'no partial reservation row was created')

      // Exactly filling the last seat is allowed.
      const last = await reserve(ev.id, { quantity: 1 }, customerCookie(booker2))
      assertEq(last.status, 200, 'taking the final seat succeeds')
      for (const row of await reservationRows(ev.id)) track('event_reservations', row.id)
      assertEq((await readEvent(ev.id))?.tickets_sold, 5, 'now full')

      const soldOut = await reserve(ev.id, { quantity: 1 }, customerCookie(booker2))
      assertEq(soldOut.status, 409, 'a sold-out event refuses further bookings')
      assertEq(soldOut.body.remaining, 0, 'reporting zero remaining')
    })

    // Final safety re-check: nothing in this suite changed the picture.
    await step('🔴 safety postflight: still no subscribers for the test city', async () => {
      await assertNoSubscribers(TEST_CITY, TEST_CATEGORY)
    })
  } catch (e) {
    if (e instanceof SubscriberSafetyError) {
      console.error(`\n🔴 ${e.message}\n`)
      assert(false, 'subscriber safety check', e.message)
    } else {
      throw e
    }
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
