// Admin → Restaurants: rejecting a pending sign-up keeps it (soft deletion).
//   - status 'rejected' + rejected_by / at / reason, deleted_at set (hidden
//     from every list), owner's team row 'removed', audited;
//   - refused for a live restaurant, twice, or for a moderator;
//   - "undo delete" never brings it back; the number can sign up again.
//   - the nightly clean-up (30-day account release + event completion)
//     never erases a row: rejected restaurants / events stay 'rejected'.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, staffCookie, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeEvent, pastDateISO } from '../testkit/fixtures'
import { releaseAccount } from '@/lib/releaseAccount'
import { completeFinishedEvents } from '@/lib/eventLifecycle'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-restaurant-reject'

type Row = { status: string; is_active: boolean; deleted_at: string | null; rejected_at: string | null; rejected_by: string | null; rejection_reason: string | null }

async function main(): Promise<void> {
  try {
    const admin = await adminCookie()
    const owner = await makeCustomer({ name: 'Reject Owner' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'reject_me', whatsapp: owner.phone, isActive: false, status: 'pending' })
    await sb.from('restaurant_team').upsert({ restaurant_id: rest.id, customer_id: owner.id, role: 'owner', status: 'active' } as never, { onConflict: 'restaurant_id,customer_id' })
    const live = await makeRestaurant({ label: 'reject_live' })
    const reject = (id: string, cookie: string, body: unknown = {}) =>
      api(`/api/admin/restaurants/${id}/reject`, { method: 'POST', cookie, body })

    await step('guards: moderator, live restaurant', async () => {
      const mod = staffCookie({ id: '00000000-0000-0000-0000-000000000000', email: 'm@test.invalid', name: 'Mod', role: 'moderator' })
      assertEq((await reject(rest.id, mod)).status, 401, 'moderator → 401')
      assertEq((await reject(live.id, admin)).status, 409, 'a live restaurant → 409')
    })

    await step('reject: kept, rejected + who / when / why, hidden, audited', async () => {
      const r = await reject(rest.id, admin, { reason: 'Photos manquantes' })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 120)})`)
      const { data } = await sb.from('restaurants').select('status, is_active, deleted_at, rejected_at, rejected_by, rejection_reason').eq('id', rest.id).maybeSingle()
      const row = data as Row | null
      assert(!!row, 'the row is kept')
      assertEq([row?.status, row?.is_active, row?.rejection_reason], ['rejected', false, 'Photos manquantes'], 'rejected, hidden, reason kept')
      assert(!!row?.rejected_at && !!row?.rejected_by && !!row?.deleted_at, 'when + who + deleted_at stored')
      const { data: team } = await sb.from('restaurant_team').select('status').eq('restaurant_id', rest.id).eq('customer_id', owner.id).maybeSingle()
      assertEq((team as { status: string } | null)?.status, 'removed', "owner's team row removed")
      const { data: audit } = await sb.from('audit_log').select('action').eq('target_id', rest.id).eq('action', 'restaurant_rejected')
      assertEq((audit ?? []).length, 1, 'one restaurant_rejected audit row')
      assertEq((await reject(rest.id, admin)).status, 409, 'rejecting twice → 409')
    })

    await step('admin list keeps it; owner cannot undo; no longer in the owner\'s list', async () => {
      const list = await api<{ restaurants: Array<{ id: string; status: string }> }>('/api/admin/restaurants', { cookie: admin })
      assertEq((list.body.restaurants ?? []).find(x => x.id === rest.id)?.status, 'rejected', 'in the admin list as rejected')
      const ownerCookie = customerCookie(owner)
      assertEq((await api(`/api/restaurants/${rest.id}/undo-delete`, { method: 'POST', cookie: ownerCookie })).status, 409, 'undo delete → 409')
      const mine = await api<{ restaurants?: Array<{ id: string }> }>('/api/vendor/restaurants', { cookie: ownerCookie })
      assert(!(mine.body.restaurants ?? []).some(x => x.id === rest.id), "not in the owner's restaurants")
    })

    await step('nightly clean-up never erases: rejected restaurant + events kept, team row kept', async () => {
      // A rejected event and a normal finished one, both in the past.
      const evRejected = await makeEvent({ organizerId: owner.id, label: 'clean_rej', date: pastDateISO(40) })
      const evDone = await makeEvent({ organizerId: owner.id, label: 'clean_done', date: pastDateISO(40) })
      await sb.from('events').update({ event_status: 'rejected', rejected_at: new Date().toISOString() } as never).eq('id', evRejected.id)
      const run = await completeFinishedEvents(undefined, { onlyIds: [evRejected.id, evDone.id] })
      assertEq(run.ids, [evDone.id], 'only the normal event is completed')

      // The 30-day account release on the owner (deleted 31 days ago).
      const longAgo = new Date(Date.now() - 31 * 86400_000).toISOString()
      await sb.from('customers').update({ status: 'deleted', deleted_at: longAgo } as never).eq('id', owner.id)
      const { data: before } = await sb.from('restaurants').select('deleted_at').eq('id', rest.id).single()
      await releaseAccount(owner.id, { type: 'system' })

      const { data: r } = await sb.from('restaurants').select('status, deleted_at, rejection_reason').eq('id', rest.id).maybeSingle()
      const row = r as { status: string; deleted_at: string; rejection_reason: string | null } | null
      assert(!!row, 'rejected restaurant still there')
      assertEq([row?.status, row?.rejection_reason], ['rejected', 'Photos manquantes'], 'still rejected, reason kept')
      assertEq(row?.deleted_at, (before as { deleted_at: string }).deleted_at, 'its deleted_at is not moved')
      const { data: evs } = await sb.from('events').select('id, event_status').in('id', [evRejected.id, evDone.id])
      const byId = Object.fromEntries(((evs ?? []) as Array<{ id: string; event_status: string }>).map(e => [e.id, e.event_status]))
      assertEq([byId[evRejected.id], byId[evDone.id]], ['rejected', 'completed'], 'both events kept: rejected stays rejected')
      const { data: team } = await sb.from('restaurant_team').select('status').eq('restaurant_id', rest.id).eq('customer_id', owner.id).maybeSingle()
      assertEq((team as { status: string } | null)?.status, 'removed', 'team row kept (removed), not deleted')
      const { data: cust } = await sb.from('customers').select('id, status').eq('id', owner.id).maybeSingle()
      assertEq((cust as { status: string } | null)?.status, 'deleted', 'customer anonymised, row kept')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
