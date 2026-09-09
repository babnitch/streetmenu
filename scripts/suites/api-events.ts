// TEST-PLAN.md §1c #34 (event lifecycle) and #35 (ticket tiers).
// (#36 vouchers lands as a separate commit.)
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

    // ══ #35 TICKET TIERS ═══════════════════════════════════════════════════

    interface TierRow {
      id: string; name: string; price: number; max_quantity: number
      sold_count: number; is_active: boolean; event_id: string
    }
    interface TierBody { ok?: boolean; tier?: TierRow; tiers?: TierRow[]; error?: string; state?: string; remaining?: number }

    const createTier = (eventId: string, body: Record<string, unknown>, cookie: string | null) =>
      api<TierBody>(`/api/events/${eventId}/tiers`, { method: 'POST', body, ...(cookie ? { cookie } : {}) })
    const patchTier = (eventId: string, tierId: string, body: Record<string, unknown>, cookie: string | null) =>
      api<TierBody>(`/api/events/${eventId}/tiers/${tierId}`, { method: 'PATCH', body, ...(cookie ? { cookie } : {}) })
    const deleteTier = (eventId: string, tierId: string, cookie: string | null) =>
      api<TierBody>(`/api/events/${eventId}/tiers/${tierId}`, { method: 'DELETE', ...(cookie ? { cookie } : {}) })
    const listTiers = (eventId: string, cookie: string | null) =>
      api<TierBody>(`/api/events/${eventId}/tiers`, { ...(cookie ? { cookie } : {}) })

    const tierRow = async (tierId: string): Promise<TierRow | null> => {
      const { data } = await sb.from('event_ticket_tiers')
        .select('id, name, price, max_quantity, sold_count, is_active, event_id')
        .eq('id', tierId).maybeSingle()
      return data as TierRow | null
    }
    // API-created tiers are invisible to the fixtures; track them so the
    // ledger owns the rows and their audit entries.
    const trackTier = (b: TierBody): string => {
      const id = b.tier?.id ?? ''
      if (id) track('event_ticket_tiers', id)
      return id
    }

    await step('#35 the organizer can create, edit and deactivate a tier', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'tier_crud', city: TEST_CITY, category: TEST_CATEGORY,
        isActive: true, ticketPrice: 1000,
      })

      const created = await createTier(ev.id, { name: 'VIP', price: 5000, max_quantity: 10 }, orgCookie)
      assertEq(created.status, 200, `create → HTTP 200 (body ${created.raw.slice(0, 160)})`)
      const tierId = trackTier(created.body)
      assert(!!tierId, 'a tier id came back')
      assertEq(created.body.tier?.event_id, ev.id, 'the tier belongs to the event from the URL')
      assertEq(created.body.tier?.is_active, true, 'created active')
      assertEq(created.body.tier?.sold_count, 0, 'and with nothing sold')

      // Edit price, quantity and name in one call.
      const edited = await patchTier(ev.id, tierId, { name: 'VIP Gold', price: 7500, max_quantity: 20 }, orgCookie)
      assertEq(edited.status, 200, 'patch → HTTP 200')
      const after = await tierRow(tierId)
      assertEq(after?.name, 'VIP Gold', 'name updated')
      assertEq(after?.price, 7500, 'price updated')
      assertEq(after?.max_quantity, 20, 'max_quantity updated')

      // A PATCH that names no recognised field is refused.
      assertEq((await patchTier(ev.id, tierId, {}, orgCookie)).status, 400, 'an empty patch → 400')

      // DELETE is a SOFT delete by design: the row survives so historical
      // reservations keep a valid tier reference; it just leaves the picker.
      const removed = await deleteTier(ev.id, tierId, orgCookie)
      assertEq(removed.status, 200, 'delete → HTTP 200')
      const gone = await tierRow(tierId)
      assert(!!gone, 'the row still EXISTS — delete is a soft delete')
      assertEq(gone?.is_active, false, 'is_active flipped to false')

      // The public list hides it; the organizer still sees it.
      const publicList = await listTiers(ev.id, null)
      assert(!(publicList.body.tiers ?? []).some(t => t.id === tierId), 'hidden from the public tier list')
      const orgList = await listTiers(ev.id, orgCookie)
      assert((orgList.body.tiers ?? []).some(t => t.id === tierId), 'still visible to the organizer')
    })

    await step('#35 tier management is organizer-only', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'tier_authz', city: TEST_CITY, category: TEST_CATEGORY, isActive: true,
      })
      const seed = await createTier(ev.id, { name: 'Guarded', price: 3000, max_quantity: 5 }, orgCookie)
      const tierId = trackTier(seed.body)

      const strangerCookie = customerCookie(booker2)
      assertEq((await createTier(ev.id, { name: 'Nope', price: 1 }, strangerCookie)).status, 403,
        'a stranger cannot create → 403')
      assertEq((await createTier(ev.id, { name: 'Nope', price: 1 }, null)).status, 401,
        'no session cannot create → 401')
      assertEq((await patchTier(ev.id, tierId, { price: 1 }, strangerCookie)).status, 403,
        'a stranger cannot edit → 403')
      assertEq((await patchTier(ev.id, tierId, { price: 1 }, null)).status, 401,
        'no session cannot edit → 401')
      assertEq((await deleteTier(ev.id, tierId, strangerCookie)).status, 403,
        'a stranger cannot deactivate → 403')
      assertEq((await deleteTier(ev.id, tierId, null)).status, 401,
        'no session cannot deactivate → 401')

      const survived = await tierRow(tierId)
      assertEq(survived?.price, 3000, 'the tier price survived every refusal')
      assertEq(survived?.is_active, true, 'and it is still active')

      assertEq((await createTier(ev.id, { price: 100 }, orgCookie)).status, 400, 'a tier with no name → 400')
    })

    await step('#35 a multi-tier booking inserts one row per tier with a price snapshot', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'multi_tier', city: TEST_CITY, category: TEST_CATEGORY, isActive: true,
      })
      const vipId = trackTier((await createTier(ev.id, { name: 'VIP', price: 5000, max_quantity: 10 }, orgCookie)).body)
      const stdId = trackTier((await createTier(ev.id, { name: 'Standard', price: 2000, max_quantity: 10 }, orgCookie)).body)

      const r = await reserve(ev.id, {
        items: [{ tier_id: vipId, quantity: 2 }, { tier_id: stdId, quantity: 3 }],
      }, bookerCookie)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 200)})`)

      const rows = await reservationRows(ev.id)
      for (const row of rows) track('event_reservations', row.id)
      assertEq(rows.length, 2, 'ONE ROW PER TIER — two tiers, two rows')

      const { data: full } = await sb.from('event_reservations')
        .select('tier_id, tier_name, tier_price, quantity, total_price').eq('event_id', ev.id)
      const byTier = new Map(((full ?? []) as Array<{ tier_id: string; tier_name: string; tier_price: number; quantity: number; total_price: number }>)
        .map(x => [x.tier_id, x]))

      assertEq(byTier.get(vipId)?.quantity, 2, 'VIP row has the VIP quantity')
      assertEq(byTier.get(vipId)?.tier_price, 5000, 'VIP row snapshots the tier price')
      assertEq(byTier.get(vipId)?.tier_name, 'VIP', 'and the tier name')
      assertEq(byTier.get(vipId)?.total_price, 10000, '2 × 5000')
      assertEq(byTier.get(stdId)?.quantity, 3, 'Standard row has its own quantity')
      assertEq(byTier.get(stdId)?.tier_price, 2000, 'Standard row snapshots its own price')
      assertEq(byTier.get(stdId)?.total_price, 6000, '3 × 2000')

      // BOTH counters move: the per-tier one and the event-wide one.
      assertEq((await tierRow(vipId))?.sold_count, 2, 'VIP sold_count += 2')
      assertEq((await tierRow(stdId))?.sold_count, 3, 'Standard sold_count += 3')
      assertEq((await readEvent(ev.id))?.tickets_sold, 5, 'event tickets_sold += 5 (the total across tiers)')

      // The snapshot is the point: repricing the tier must not rewrite history.
      assertEq((await patchTier(ev.id, vipId, { price: 9999 }, orgCookie)).status, 200, 'the organizer reprices VIP')
      assertEq((await tierRow(vipId))?.price, 9999, 'the tier now costs 9999')
      const { data: after } = await sb.from('event_reservations')
        .select('tier_price, total_price').eq('event_id', ev.id).eq('tier_id', vipId).maybeSingle()
      assertEq((after as { tier_price?: number } | null)?.tier_price, 5000,
        'the EXISTING booking still says 5000 — the snapshot held')
      assertEq((after as { total_price?: number } | null)?.total_price, 10000,
        'and its total is unchanged')
    })

    await step('#35 a sold-out tier is refused, whole rather than partially', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'tier_soldout', city: TEST_CITY, category: TEST_CATEGORY, isActive: true,
      })
      const smallId = trackTier((await createTier(ev.id, { name: 'Small', price: 1000, max_quantity: 3 }, orgCookie)).body)
      const roomyId = trackTier((await createTier(ev.id, { name: 'Roomy', price: 1000, max_quantity: 50 }, orgCookie)).body)

      assertEq((await reserve(ev.id, { items: [{ tier_id: smallId, quantity: 3 }] }, bookerCookie)).status, 200,
        'filling the tier exactly succeeds')
      for (const row of await reservationRows(ev.id)) track('event_reservations', row.id)
      assertEq((await tierRow(smallId))?.sold_count, 3, 'the tier is now full')

      const soldOut = await reserve(ev.id, { items: [{ tier_id: smallId, quantity: 1 }] }, customerCookie(booker2))
      assertEq(soldOut.status, 409, 'the next booking on that tier → 409')
      assertEq((soldOut.body as { state?: string }).state, 'sold_out', "reported as state='sold_out'")
      assertEq((await tierRow(smallId))?.sold_count, 3, 'sold_count unchanged by the refusal')
      assertEq((await reservationRows(ev.id)).length, 1, 'no extra reservation row')

      // A mixed basket where ONE line overflows must fail whole — the roomy
      // tier must not be partially booked.
      const roomyBefore = (await tierRow(roomyId))?.sold_count ?? 0
      const mixed = await reserve(ev.id, {
        items: [{ tier_id: roomyId, quantity: 2 }, { tier_id: smallId, quantity: 1 }],
      }, customerCookie(booker2))
      assertEq(mixed.status, 409, 'a basket containing a sold-out tier → 409')
      assertEq((await tierRow(roomyId))?.sold_count, roomyBefore,
        'the OTHER tier in the same basket was not booked — whole or nothing')
      assertEq((await reservationRows(ev.id)).length, 1, 'still just the original reservation')
      assertEq((await readEvent(ev.id))?.tickets_sold, 3, 'and the event counter did not move')
    })

    await step('#35 a partially-full tier reports what is left', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'tier_partial', city: TEST_CITY, category: TEST_CATEGORY, isActive: true,
      })
      const tId = trackTier((await createTier(ev.id, { name: 'Five', price: 500, max_quantity: 5 }, orgCookie)).body)

      assertEq((await reserve(ev.id, { items: [{ tier_id: tId, quantity: 4 }] }, bookerCookie)).status, 200,
        'booking 4 of 5 succeeds')
      for (const row of await reservationRows(ev.id)) track('event_reservations', row.id)

      const over = await reserve(ev.id, { items: [{ tier_id: tId, quantity: 2 }] }, customerCookie(booker2))
      assertEq(over.status, 409, 'asking for 2 when 1 remains → 409')
      assertEq((over.body as { remaining?: number }).remaining, 1, 'and it reports remaining=1')
      assertEq((await tierRow(tId))?.sold_count, 4, 'sold_count unchanged')
    })

    await step('#35 an inactive tier cannot be booked', async () => {
      const ev = await makeEvent({
        organizerId: organizer.id, label: 'tier_inactive', city: TEST_CITY, category: TEST_CATEGORY, isActive: true,
      })
      const tId = trackTier((await createTier(ev.id, { name: 'Retired', price: 500, max_quantity: 10 }, orgCookie)).body)
      assertEq((await deleteTier(ev.id, tId, orgCookie)).status, 200, 'the organizer deactivates it')

      const r = await reserve(ev.id, { items: [{ tier_id: tId, quantity: 1 }] }, bookerCookie)
      assertEq(r.status, 409, 'booking a deactivated tier → 409')
      assertEq((r.body as { state?: string }).state, 'inactive', "reported as state='inactive'")
      assertEq((await reservationRows(ev.id)).length, 0, 'no reservation row was created')
    })

    await step("#35 a tier belonging to another event is unreachable", async () => {
      const evA = await makeEvent({
        organizerId: organizer.id, label: 'tier_x_a', city: TEST_CITY, category: TEST_CATEGORY, isActive: true,
      })
      const evB = await makeEvent({
        organizerId: organizer.id, label: 'tier_x_b', city: TEST_CITY, category: TEST_CATEGORY, isActive: true,
      })
      const tierB = trackTier((await createTier(evB.id, { name: 'B only', price: 4000, max_quantity: 10 }, orgCookie)).body)

      // Reserve: the lookup is scoped `.eq('event_id', …).in('id', …)`, so a
      // foreign tier id simply is not found for event A.
      const r = await reserve(evA.id, { items: [{ tier_id: tierB, quantity: 1 }] }, bookerCookie)
      assertEq(r.status, 404, "booking B's tier through event A → 404")
      assertEq((await tierRow(tierB))?.sold_count, 0, "B's tier sold nothing")
      assertEq((await reservationRows(evA.id)).length, 0, 'and event A has no reservation')

      // Management: authorize() matches the tier on BOTH ids, so the same
      // laundering fails there too.
      assertEq((await patchTier(evA.id, tierB, { price: 1 }, orgCookie)).status, 404,
        "editing B's tier through event A → 404")
      assertEq((await deleteTier(evA.id, tierB, orgCookie)).status, 404,
        "deactivating B's tier through event A → 404")
      const untouched = await tierRow(tierB)
      assertEq(untouched?.price, 4000, "B's tier price is unchanged")
      assertEq(untouched?.is_active, true, 'and it is still active')
    })

    await step('#35 tier actions write audit rows', async () => {
      const { data } = await sb.from('audit_log').select('action')
        .in('action', ['tier_created', 'tier_updated', 'tier_deactivated'])
        .gte('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
      const actions = new Set((data ?? []).map(a => (a as { action: string }).action))
      for (const a of ['tier_created', 'tier_updated', 'tier_deactivated']) {
        assert(actions.has(a), `${a} audit row written`)
      }
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
