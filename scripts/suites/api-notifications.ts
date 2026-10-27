// TEST-PLAN.md §1c #26 (notify-order) and #27 (approve-welcome).
//
// Ported unchanged in what they assert from:
//   scripts/test-notify-order.ts
//   scripts/test-approve-welcome.ts
//
// Both are API + EXT-soft: Twilio 401s locally against the fake creds, and
// that is fine — §1d says assert on orchestration and route responses, never
// on delivery. notify-order's customerNotified/vendorFanoutStatus and
// approve's welcomedOwners are computed from promise settlement, not from
// Twilio's answer, so they are stable without a working provider.
//
// The Twilio attempts write message_log rows. Nothing cleaned those before —
// a baseline run of the two originals left 21 behind (§4 hazard 4). The
// ledger's phone-keyed teardown removes them now.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, customerCookie } from '../testkit/session'
import { vendorRecipients } from '@/lib/whatsapp/ordering'
import { organizerPhones } from '@/lib/eventRecipients'
import { makeCustomer, makeRestaurant, makeOrder, addTeamMember, makeEvent, futureDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-notifications'

async function main(): Promise<void> {
  try {
    // ── #26 notify-order ───────────────────────────────────────────────────
    // Restaurant carries the owner's phone directly — stored WITHOUT the "+",
    // as hand-typed numbers often are — AND an active owner team row on the
    // same number, so the deduper must collapse to one recipient.
    const customer = await makeCustomer({ suiteNo: 26, name: 'Web Customer' })
    const owner    = await makeCustomer({ suiteNo: 26, name: 'Web Owner' })
    const rest     = await makeRestaurant({ ownerId: owner.id, label: 'notify_order', whatsapp: owner.phone.replace(/^\+/, '') })
    await addTeamMember(rest.id, owner.id, 'owner')
    const custCookie = customerCookie(customer)

    await step('vendor recipients: "237…" and "+237…" for the same owner → one number', async () => {
      const r = await vendorRecipients(rest.id)
      assertEq(r, [owner.phone], `one recipient, normalised (got ${JSON.stringify(r)})`)
    })

    const order = await makeOrder(rest.id, customer, {
      status: 'pending',
      items: [
        { name: 'Ndolé', quantity: 2, price: 2500 },
        { name: 'Eru',   quantity: 1, price: 2000 },
      ],
      total: 7000,
    })

    await step('notify-order: no session on a customer order → 403, other customer → 403', async () => {
      assertEq((await api('/api/whatsapp/notify-order', { body: { orderId: order.id } })).status, 403, 'anonymous → 403')
      const other = await makeCustomer({ suiteNo: 26, name: 'Other Customer' })
      const r = await api('/api/whatsapp/notify-order', { cookie: customerCookie(other), body: { orderId: order.id } })
      assertEq(r.status, 403, 'someone else → 403')
    })

    await step('notify-order for a valid order → ok, both sides attempted', async () => {
      const r = await api<{ ok?: boolean; customerNotified?: boolean; vendorFanoutStatus?: string }>(
        '/api/whatsapp/notify-order', { cookie: custCookie, body: { orderId: order.id } },
      )
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 200)})`)
      assertEq(r.body.ok, true, 'ok=true')
      // customerNotified is true iff customer_phone existed AND the notify
      // promise resolved. A Twilio 401 still RESOLVES — sendWhatsApp always
      // returns rather than throwing — so this is delivery-independent.
      assertEq(r.body.customerNotified, true, 'customerNotified=true (customer_phone present)')
      assertEq(r.body.vendorFanoutStatus, 'fulfilled', 'vendor fan-out fulfilled (not rejected)')
    })

    await step('notify-order a second time → nothing sent again', async () => {
      const { data: row } = await sb.from('orders').select('notified_at').eq('id', order.id).single()
      assert(!!(row as { notified_at?: string | null } | null)?.notified_at, 'orders.notified_at set by the first call')
      const r = await api<{ ok?: boolean; alreadySent?: boolean; customerNotified?: boolean }>(
        '/api/whatsapp/notify-order', { cookie: custCookie, body: { orderId: order.id } },
      )
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.alreadySent, true, 'alreadySent=true')
      assertEq(r.body.customerNotified, undefined, 'no send attempted')
      // One customer message + one restaurant message, in total, across both calls.
      const { data: logs } = await sb.from('message_log').select('to_number')
        .eq('related_id', order.id).eq('context', 'order_notification')
      assertEq((logs ?? []).length, 2, `2 messages logged for the order (got ${(logs ?? []).length})`)
    })

    await step('notify-order on a paid order → 409 (the payment sends its messages)', async () => {
      const paid = await makeOrder(rest.id, customer, { extra: { order_type: 'paid_order', payment_status: 'paid' } })
      const r = await api('/api/whatsapp/notify-order', { cookie: custCookie, body: { orderId: paid.id } })
      assertEq(r.status, 409, `HTTP 409 (body ${r.raw.slice(0, 160)})`)
    })

    await step('guest order: allowed just after placing, refused once stale', async () => {
      const fresh = await makeOrder(rest.id, customer, { extra: { customer_id: null } })
      const ok = await api<{ ok?: boolean }>('/api/whatsapp/notify-order', { body: { orderId: fresh.id } })
      assertEq(ok.status, 200, `fresh guest order → 200 (body ${ok.raw.slice(0, 160)})`)
      const stale = await makeOrder(rest.id, customer, {
        extra: { customer_id: null, created_at: new Date(Date.now() - 60 * 60_000).toISOString() },
      })
      const no = await api('/api/whatsapp/notify-order', { body: { orderId: stale.id } })
      assertEq(no.status, 403, 'guest order older than 15 min → 403')
    })

    await step('notify-order with missing orderId → 400', async () => {
      const r = await api('/api/whatsapp/notify-order', { body: {} })
      assertEq(r.status, 400, 'HTTP 400 for missing orderId')
    })

    await step('notify-order with unknown orderId → 404', async () => {
      const r = await api('/api/whatsapp/notify-order', {
        body: { orderId: '00000000-0000-0000-0000-000000000000' },
      })
      assertEq(r.status, 404, 'HTTP 404 for missing order row')
    })

    // ── #27 approve-welcome ────────────────────────────────────────────────
    const pendingOwner = await makeCustomer({ suiteNo: 27, name: 'Test Owner' })
    const pendingRest  = await makeRestaurant({
      ownerId: pendingOwner.id, label: 'approve_welcome', whatsapp: pendingOwner.phone,
      status: 'pending', isActive: false,
    })
    // Register the owner in restaurant_team too, to exercise the full
    // recipient fan-out rather than just the customer_id path.
    await addTeamMember(pendingRest.id, pendingOwner.id, 'owner')
    const admin = await adminCookie()

    await step('first approve — pending → active, welcome sent', async () => {
      const r = await api<{ ok?: boolean; welcomedOwners?: boolean }>(
        `/api/restaurants/${pendingRest.id}/approve`, { method: 'POST', cookie: admin },
      )
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 200)})`)
      assertEq(r.body.ok, true, 'ok=true')
      assertEq(r.body.welcomedOwners, true, 'welcomedOwners=true on the transition')

      const { data } = await sb.from('restaurants').select('status').eq('id', pendingRest.id).maybeSingle()
      assertEq((data as { status?: string } | null)?.status, 'active', "restaurants.status = 'active'")
    })

    await step('the transition writes a restaurant_approved audit row', async () => {
      const { data } = await sb.from('audit_log')
        .select('action, target_id, previous_data')
        .eq('target_id', pendingRest.id).eq('action', 'restaurant_approved')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      assert(!!data, 'restaurant_approved audit row exists')
      const prev = (data as { previous_data?: { status?: string } } | null)?.previous_data
      assertEq(prev?.status, 'pending', "audit previous_data.status = 'pending'")
    })

    await step('second approve — already active, welcome NOT re-sent', async () => {
      const r = await api<{ ok?: boolean; welcomedOwners?: boolean }>(
        `/api/restaurants/${pendingRest.id}/approve`, { method: 'POST', cookie: admin },
      )
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.ok, true, 'ok=true')
      assertEq(r.body.welcomedOwners, false, 'welcomedOwners=false on re-approval (no-spam)')
    })

    await step('approve without a session → 401', async () => {
      const r = await api(`/api/restaurants/${pendingRest.id}/approve`, { method: 'POST' })
      assertEq(r.status, 401, 'HTTP 401 for unauthenticated')
    })

    // ── C3: organiser recipients and contact numbers ───────────────────────
    const org = await makeCustomer({ suiteNo: 26, name: 'Organiser C3' })
    const extra = await makeCustomer({ suiteNo: 26, name: 'Extra Number' })

    await step('organiser recipients: account phone + the extra number, deduplicated', async () => {
      const ev = await makeEvent({ organizerId: org.id, label: 'c3_recipients', extra: { notify_phone: extra.phone } })
      assertEq(await organizerPhones({ id: ev.id }), [org.phone, extra.phone], 'both numbers, account first')
      await sb.from('events').update({ notify_phone: null } as never).eq('id', ev.id)
      assertEq(await organizerPhones({ id: ev.id }), [org.phone], 'no extra number → account only')
      const legacy = await makeEvent({ label: 'c3_legacy', extra: { organizer_id: null } })
      const { data: l } = await sb.from('events').select('whatsapp').eq('id', legacy.id).single()
      assertEq(await organizerPhones({ id: legacy.id }), [(l as { whatsapp: string }).whatsapp], 'no organiser account → the event contact')
    })

    await step('event submit: contact = account phone, extra number normalised', async () => {
      const cookie = customerCookie(org)
      const base = { title: testName('c3_submit'), date: futureDateISO(20), city: testName('city'), category: 'Autre', ticket_price: 0, organizer_name: 'Asso' }
      const bad = await api<{ field?: string }>('/api/events/submit', { cookie, body: { ...base, notify_phone: '12' } })
      assertEq(bad.status, 400, 'unusable extra number → 400')
      assertEq(bad.body.field, 'notify_phone', 'error names the field')
      const r = await api<{ event_id?: string }>('/api/events/submit', {
        cookie, body: { ...base, whatsapp: '+999 555 0100', notify_phone: '+999 260 0099' },
      })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 120)})`)
      track('events', r.body.event_id)
      const { data: ev } = await sb.from('events').select('whatsapp, notify_phone').eq('id', r.body.event_id ?? '').single()
      assertEq((ev as { whatsapp: string }).whatsapp, org.phone, 'contact is the account phone (a typed one is ignored)')
      assertEq((ev as { notify_phone: string }).notify_phone, '+9992600099', 'extra number normalised (spaces removed)')
      const same = await api<{ event_id?: string }>('/api/events/submit', {
        cookie, body: { ...base, title: testName('c3_submit_same'), notify_phone: org.phone },
      })
      track('events', same.body.event_id)
      const { data: ev2 } = await sb.from('events').select('notify_phone').eq('id', same.body.event_id ?? '').single()
      assertEq((ev2 as { notify_phone: string | null }).notify_phone, null, 'the account number as "extra" → stored as none')
    })

    await step('send guard: a real-looking number gets nothing and leaves no log row', async () => {
      // A verified organiser: "Événement publié" goes to both numbers, so the
      // real-looking extra number really is sent to — and must be refused.
      const verified = await makeCustomer({ suiteNo: 26, name: 'Verified Organiser', extra: { event_auto_approve: true } })
      const cookie = customerCookie(verified)
      const real = '+237 699 00 00 09'
      const r = await api<{ event_id?: string }>('/api/events/submit', {
        cookie, body: { title: testName('c3_guard'), date: futureDateISO(20), city: testName('city'), category: 'Autre', ticket_price: 0, organizer_name: 'Asso', notify_phone: real },
      })
      assertEq(r.status, 200, 'submit still works')
      track('events', r.body.event_id)
      const { data } = await sb.from('message_log').select('id').in('to_number', ['+237699000009', 'whatsapp:+237699000009'])
      assertEq((data ?? []).length, 0, 'no message (and no log row) to the real-looking number')
      await sb.from('events').update({ notify_phone: null } as never).eq('id', r.body.event_id ?? '')
    })

    await step('event edit: the extra number can be changed and cleared', async () => {
      const ev = await makeEvent({ organizerId: org.id, label: 'c3_edit' })
      const cookie = customerCookie(org)
      const set = await api(`/api/events/${ev.id}`, { method: 'PATCH', cookie, body: { notify_phone: '+999 260 0098' } })
      assertEq(set.status, 200, 'PATCH → 200')
      let { data } = await sb.from('events').select('notify_phone').eq('id', ev.id).single()
      assertEq((data as { notify_phone: string }).notify_phone, '+9992600098', 'saved normalised')
      await api(`/api/events/${ev.id}`, { method: 'PATCH', cookie, body: { notify_phone: '' } })
      ;({ data } = await sb.from('events').select('notify_phone').eq('id', ev.id).single())
      assertEq((data as { notify_phone: string | null }).notify_phone, null, "'' clears it")
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
