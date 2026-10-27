// Paid broadcasts are an admin-granted capability (supabase-broadcast-
// capability.sql): restaurants.broadcast_enabled / customers.broadcast_enabled,
// default false. Before it, any client with one approved event — or owning an
// approved restaurant — could reach the composer, and /preview answered any
// logged-in customer.
//
// Never calls /create past its eligibility gate (that would start a PawaPay
// deposit) and never lets /send fan out: the one /send call is for a sender
// who is NOT enabled, so it must be refused, and its target city is
// run-namespaced, so even a regression would reach zero subscribers.
//
// The "enabled" half needs the migration. If the column is missing the suite
// warns and skips it; the refusal half passes either way (the gate fails
// closed).

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, warn, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeEvent } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-broadcast-capability'

interface Eligibility {
  eligible: boolean
  asPublisher: boolean
  asRestaurants: Array<{ id: string }>
}

async function main(): Promise<void> {
  try {
    // A "verified publisher" under the old rule: approved events + auto-approve.
    const publisher = await makeCustomer({
      suiteNo: 60, name: 'Old-rule publisher',
      extra: { events_approved_count: 3, event_auto_approve: true },
    })
    const owner = await makeCustomer({ suiteNo: 60, name: 'Restaurant owner' })
    const rest  = await makeRestaurant({ ownerId: owner.id, label: 'bcast_cap', status: 'active' })
    const plain = await makeCustomer({ suiteNo: 60, name: 'Plain client' })
    const organizer = await makeCustomer({
      suiteNo: 60, name: 'Organizer', extra: { event_auto_approve: false },
    })
    await makeEvent({ organizerId: organizer.id, label: 'bcast_cap_event' })

    const city = testName('city')

    await step('old-rule publisher is NOT eligible by default', async () => {
      const r = await api<Eligibility>('/api/broadcasts/eligibility', { cookie: customerCookie(publisher) })
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.eligible, false, 'eligible=false')
      assertEq(r.body.asPublisher, false, 'asPublisher=false')
    })

    await step('owner of an active restaurant is NOT eligible by default', async () => {
      const r = await api<Eligibility>('/api/broadcasts/eligibility', { cookie: customerCookie(owner) })
      assertEq(r.body.eligible, false, 'eligible=false')
      assertEq(r.body.asRestaurants.length, 0, 'no restaurant senders')
    })

    await step('preview: plain client → 403', async () => {
      const r = await api('/api/broadcasts/preview', {
        cookie: customerCookie(plain), body: { target_city: 'Yaoundé' },
      })
      assertEq(r.status, 403, `HTTP 403 (body ${r.raw.slice(0, 120)})`)
    })

    await step('preview: organizer (not enabled) → audience size only, no cost', async () => {
      const r = await api<Record<string, unknown>>('/api/broadcasts/preview', {
        cookie: customerCookie(organizer), body: { target_city: 'Yaoundé' },
      })
      assertEq(r.status, 200, 'HTTP 200')
      assert(typeof r.body.recipients === 'number', 'recipients is a number')
      assertEq('cost' in r.body, false, 'no cost')
      assertEq('pricing' in r.body, false, 'no pricing')
    })

    await step('create: old-rule publisher → 403 before any deposit', async () => {
      const r = await api('/api/broadcasts/create', {
        cookie: customerCookie(publisher),
        body: {
          title: 'x', message: 'y', target_city: 'Yaoundé',
          sender_type: 'publisher', phone_number: '+999270000000',
        },
      })
      assertEq(r.status, 403, `HTTP 403 (body ${r.raw.slice(0, 120)})`)
    })

    await step('create: owner sending as their restaurant → 403', async () => {
      const r = await api('/api/broadcasts/create', {
        cookie: customerCookie(owner),
        body: {
          title: 'x', message: 'y', target_city: 'Yaoundé',
          sender_type: 'restaurant', restaurant_id: rest.id, phone_number: '+999270000000',
        },
      })
      assertEq(r.status, 403, `HTTP 403 (body ${r.raw.slice(0, 120)})`)
    })

    await step('send: paid broadcast from a sender who is not enabled → 403, nothing sent', async () => {
      const { data, error } = await sb.from('broadcasts').insert({
        sender_id: publisher.id, sender_type: 'publisher', title: testName('bcast'), message: 'test',
        target_city: city, recipient_count: 0, cost: 1000,
        payment_status: 'paid', status: 'paid',
      } as never).select('id').single()
      if (error || !data) throw new Error(`insert broadcasts: ${error?.message}`)
      const id = (data as { id: string }).id
      track('broadcasts', id)

      const r = await api(`/api/broadcasts/${id}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.INTERNAL_API_SECRET ?? ''}` },
      })
      assertEq(r.status, 403, `HTTP 403 (body ${r.raw.slice(0, 120)})`)
      const { data: row } = await sb.from('broadcasts').select('status, sent_at').eq('id', id).single()
      assertEq(row?.status, 'paid', "row stays 'paid'")
      assertEq(row?.sent_at ?? null, null, 'sent_at not set')
    })

    await step('admin toggle routes: customer session → 403', async () => {
      const a = await api(`/api/admin/accounts/${publisher.id}/broadcast`, {
        method: 'PATCH', cookie: customerCookie(publisher), body: { broadcast_enabled: true },
      })
      assertEq(a.status, 403, 'accounts toggle 403')
      const b = await api(`/api/admin/restaurants/${rest.id}/broadcast`, {
        method: 'PATCH', cookie: customerCookie(owner), body: { broadcast_enabled: true },
      })
      assertEq(b.status, 403, 'restaurants toggle 403')
    })

    // ── Enabled half — needs supabase-broadcast-capability.sql ──────────────
    const { error: colErr } = await sb.from('customers').select('broadcast_enabled').limit(1)
    if (colErr) {
      warn('broadcast_enabled column missing — run supabase-broadcast-capability.sql; enabled-path checks skipped')
    } else {
      const admin = await adminCookie()

      await step('admin enables publisher → eligible as publisher', async () => {
        const t = await api(`/api/admin/accounts/${publisher.id}/broadcast`, {
          method: 'PATCH', cookie: admin, body: { broadcast_enabled: true },
        })
        assertEq(t.status, 200, `toggle HTTP 200 (body ${t.raw.slice(0, 120)})`)
        const r = await api<Eligibility>('/api/broadcasts/eligibility', { cookie: customerCookie(publisher) })
        assertEq(r.body.asPublisher, true, 'asPublisher=true')
      })

      await step('admin enables restaurant → owner can send as it', async () => {
        const t = await api(`/api/admin/restaurants/${rest.id}/broadcast`, {
          method: 'PATCH', cookie: admin, body: { broadcast_enabled: true },
        })
        assertEq(t.status, 200, `toggle HTTP 200 (body ${t.raw.slice(0, 120)})`)
        const r = await api<Eligibility>('/api/broadcasts/eligibility', { cookie: customerCookie(owner) })
        assertEq(r.body.asRestaurants.map(x => x.id), [rest.id], 'restaurant listed')
      })

      await step('broadcast_blocked overrides an enabled publisher', async () => {
        await sb.from('customers').update({ broadcast_blocked: true } as never).eq('id', publisher.id)
        const r = await api<Eligibility & { blocked: boolean }>('/api/broadcasts/eligibility', { cookie: customerCookie(publisher) })
        assertEq(r.body.asPublisher, false, 'asPublisher=false')
        assertEq(r.body.blocked, true, 'blocked=true')
      })
    }
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
