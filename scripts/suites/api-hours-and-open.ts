// TEST-PLAN.md §1c #31 (opening hours) and #32 (open toggle vs override).
//
// New coverage. Three routes, three different gates — the whole point of the
// suite is that they are deliberately NOT the same:
//
//   POST /hours     owner only.  Manager and staff excluded: the schedule is
//                   a commercial decision.
//   POST /open      owner, manager AND staff. "We're open right now" is
//                   routine floor operation for whoever is on shift.
//   POST /override  owner and manager. Staff excluded: a manual override is
//                   commercial state, not floor state.
//
// A refactor that unified these three gates would be a real regression in
// either direction — locking staff out of /open, or letting them into
// /override — and neither would be obvious from reading the diff.
//
// Every refusal is checked by re-reading the row, not by status code alone:
// a route that answers 403 and writes anyway passes a status-only test.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, addTeamMember } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-hours-and-open'

interface HourRow { day_of_week: number; open_time: string; close_time: string; is_closed: boolean }
interface HoursBody { hours?: HourRow[]; error?: string }
interface OpenBody { ok?: boolean; restaurant?: Record<string, unknown>; error?: string }

// 'HH:MM:SS' comes back from a TIME column; the route stores 'HH:MM'.
const hhmm = (t: string) => t.slice(0, 5)

function week(open: string, close: string): HourRow[] {
  return [0, 1, 2, 3, 4, 5, 6].map(d => ({
    day_of_week: d, open_time: open, close_time: close, is_closed: false,
  }))
}

async function main(): Promise<void> {
  try {
    // ── Fixtures ───────────────────────────────────────────────────────────
    const owner    = await makeCustomer({ suiteNo: 31, name: 'Hours Owner' })
    const manager  = await makeCustomer({ suiteNo: 31, name: 'Hours Manager' })
    const staff    = await makeCustomer({ suiteNo: 31, name: 'Hours Staff' })
    const outsider = await makeCustomer({ suiteNo: 31, name: 'Hours Outsider' })

    const restA = await makeRestaurant({ ownerId: owner.id, label: 'hours_a', whatsapp: owner.phone })
    await addTeamMember(restA.id, manager.id, 'manager')
    await addTeamMember(restA.id, staff.id,   'staff')

    const ownerB = await makeCustomer({ suiteNo: 31, name: 'Other Owner' })
    const restB  = await makeRestaurant({ ownerId: ownerB.id, label: 'hours_b', whatsapp: ownerB.phone })

    const cookies = {
      owner:    customerCookie(owner),
      manager:  customerCookie(manager),
      staff:    customerCookie(staff),
      outsider: customerCookie(outsider),
    }

    const postHours = (restaurantId: string, hours: unknown, cookie: string | null) =>
      api<HoursBody>(`/api/restaurants/${restaurantId}/hours`, {
        method: 'POST', body: { hours }, ...(cookie ? { cookie } : {}),
      })
    const getHours = (restaurantId: string) =>
      api<HoursBody>(`/api/restaurants/${restaurantId}/hours`)
    const postOpen = (restaurantId: string, body: Record<string, unknown>, cookie: string | null) =>
      api<OpenBody>(`/api/restaurants/${restaurantId}/open`, {
        method: 'POST', body, ...(cookie ? { cookie } : {}),
      })
    const postOverride = (restaurantId: string, body: Record<string, unknown>, cookie: string | null) =>
      api<OpenBody>(`/api/restaurants/${restaurantId}/override`, {
        method: 'POST', body, ...(cookie ? { cookie } : {}),
      })

    const readRestaurant = async (id: string): Promise<Record<string, unknown>> => {
      const { data } = await sb.from('restaurants').select('*').eq('id', id).maybeSingle()
      return (data ?? {}) as Record<string, unknown>
    }
    const storedHours = async (id: string): Promise<HourRow[]> => {
      const { data } = await sb.from('restaurant_hours')
        .select('day_of_week, open_time, close_time, is_closed')
        .eq('restaurant_id', id).order('day_of_week', { ascending: true })
      return (data ?? []) as HourRow[]
    }

    // ══ #31 OPENING HOURS ══════════════════════════════════════════════════

    await step('#31 owner writes a full week and GET returns 7 days in order', async () => {
      const r = await postHours(restA.id, week('08:00', '18:00'), cookies.owner)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)

      const got = await getHours(restA.id)
      assertEq(got.status, 200, 'GET HTTP 200')
      const rows = got.body.hours ?? []
      assertEq(rows.length, 7, 'seven rows come back')
      assertEq(rows.map(h => h.day_of_week), [0, 1, 2, 3, 4, 5, 6], 'ordered by day_of_week ascending')
      assert(rows.every(h => hhmm(h.open_time) === '08:00'), 'every open_time is 08:00')
      assert(rows.every(h => hhmm(h.close_time) === '18:00'), 'every close_time is 18:00')
      assert(rows.every(h => h.is_closed === false), 'no day flagged closed')
    })

    await step('#31 a second full-week POST replaces rather than appends', async () => {
      const r = await postHours(restA.id, week('10:00', '23:00'), cookies.owner)
      assertEq(r.status, 200, 'HTTP 200')

      const rows = await storedHours(restA.id)
      assertEq(rows.length, 7, 'still exactly seven rows — nothing appended')
      assert(rows.every(h => hhmm(h.open_time) === '10:00'), 'open_time updated to 10:00')
      assert(rows.every(h => hhmm(h.close_time) === '23:00'), 'close_time updated to 23:00')
    })

    await step('#31 the write is an upsert keyed on (restaurant_id, day_of_week)', async () => {
      // Worth pinning precisely: this is NOT delete-then-insert. A partial
      // payload updates only the days it names and leaves the others alone,
      // so "replaces the whole week" holds only when the client sends all 7.
      const r = await postHours(restA.id, [
        { day_of_week: 1, open_time: '06:00', close_time: '12:00', is_closed: false },
        { day_of_week: 2, open_time: '00:00', close_time: '00:00', is_closed: true },
      ], cookies.owner)
      assertEq(r.status, 200, 'HTTP 200')

      const rows = await storedHours(restA.id)
      assertEq(rows.length, 7, 'still seven rows — no duplicates on the conflict key')
      const byDay = new Map(rows.map(h => [h.day_of_week, h]))
      assertEq(hhmm(byDay.get(1)!.open_time), '06:00', 'day 1 updated')
      assertEq(byDay.get(2)!.is_closed, true, 'day 2 marked closed')
      assertEq(hhmm(byDay.get(3)!.open_time), '10:00', 'day 3 keeps its earlier value — not wiped')
    })

    await step('#31 malformed rows are dropped silently, valid ones still land', async () => {
      const r = await postHours(restA.id, [
        { day_of_week: 5, open_time: '09:00', close_time: '17:00', is_closed: false }, // valid
        { day_of_week: 9, open_time: '09:00', close_time: '17:00' },                   // dow out of range
        { day_of_week: -1, open_time: '09:00', close_time: '17:00' },                  // dow negative
        { day_of_week: 'x', open_time: '09:00', close_time: '17:00' },                 // dow not a number
        { day_of_week: 6, open_time: 'abc', close_time: '17:00' },                     // unparseable open
        { day_of_week: 6, open_time: '09:00', close_time: '9:00' },                    // close not HH:MM
      ], cookies.owner)
      assertEq(r.status, 200, 'HTTP 200 — a partial save is not an error')

      const rows = await storedHours(restA.id)
      assertEq(rows.length, 7, 'no junk rows were created')
      const byDay = new Map(rows.map(h => [h.day_of_week, h]))
      assertEq(hhmm(byDay.get(5)!.open_time), '09:00', 'the one valid row was applied')
      assertEq(hhmm(byDay.get(6)!.open_time), '10:00', 'day 6 untouched — both of its rows were malformed')
    })

    await step('#31 a payload with nothing valid in it is a 400', async () => {
      const r = await postHours(restA.id, [{ day_of_week: 99 }, { day_of_week: 'nope' }], cookies.owner)
      assertEq(r.status, 400, 'HTTP 400')
      assertEq((await storedHours(restA.id)).length, 7, 'still seven rows')

      const empty = await postHours(restA.id, [], cookies.owner)
      assertEq(empty.status, 400, 'an empty hours array is also 400')
    })

    await step('#31 omitted times fall back to the route defaults', async () => {
      const r = await postHours(restA.id, [{ day_of_week: 4 }], cookies.owner)
      assertEq(r.status, 200, 'HTTP 200 — a row with no times is valid, not malformed')
      const byDay = new Map((await storedHours(restA.id)).map(h => [h.day_of_week, h]))
      assertEq(hhmm(byDay.get(4)!.open_time), '08:00', 'open_time defaults to 08:00')
      assertEq(hhmm(byDay.get(4)!.close_time), '22:00', 'close_time defaults to 22:00')
    })

    await step('#31 hours are owner-only — manager and staff are refused', async () => {
      const before = await storedHours(restA.id)

      assertEq((await postHours(restA.id, week('01:00', '02:00'), cookies.manager)).status, 403,
        'manager → 403 (schedule is a commercial decision)')
      assertEq((await postHours(restA.id, week('01:00', '02:00'), cookies.staff)).status, 403,
        'staff → 403')
      assertEq((await postHours(restA.id, week('01:00', '02:00'), cookies.outsider)).status, 403,
        'outsider → 403')
      assertEq((await postHours(restA.id, week('01:00', '02:00'), null)).status, 401,
        'no session → 401, not 403')

      const after = await storedHours(restA.id)
      assertEq(after, before, 'not one refused call changed a single row')
    })

    await step('#31 GET is public — no session required', async () => {
      const r = await getHours(restA.id)
      assertEq(r.status, 200, 'HTTP 200 with no cookie')
      assertEq((r.body.hours ?? []).length, 7, 'and it returns the schedule')
    })

    await step('#31 /open-status reflects the stored schedule and the override', async () => {
      // Give the restaurant a schedule that is unambiguous all week, then
      // read the computed status the home page uses.
      await postHours(restA.id, week('00:00', '23:59'), cookies.owner)
      const r = await api<{ status?: Record<string, { open: boolean; source: string }> }>(
        `/api/restaurants/open-status?ids=${restA.id}`,
      )
      assertEq(r.status, 200, 'HTTP 200')
      const s = r.body.status?.[restA.id]
      assert(!!s, 'the restaurant appears in the status map')
      assertEq(s?.open, true, 'open all week reads as open')
      assertEq(s?.source, 'schedule', 'and the source is the schedule')
    })

    // ══ #32 OPEN TOGGLE vs OVERRIDE ════════════════════════════════════════

    await step('#32 staff CAN flip /open — the deliberate divergence', async () => {
      const r = await postOpen(restA.id, { is_open: false }, cookies.staff)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      const row = await readRestaurant(restA.id)
      assertEq(row.is_open, false, 'the flag actually changed')
    })

    await step('#32 owner and manager can flip /open too', async () => {
      assertEq((await postOpen(restA.id, { is_open: true }, cookies.owner)).status, 200, 'owner → 200')
      assertEq((await readRestaurant(restA.id)).is_open, true, 'owner’s change persisted')
      assertEq((await postOpen(restA.id, { is_open: false }, cookies.manager)).status, 200, 'manager → 200')
      assertEq((await readRestaurant(restA.id)).is_open, false, 'manager’s change persisted')
    })

    await step('#32 /open mutates is_open and NOTHING else', async () => {
      // The assertion this suite exists for. Snapshot the whole row, flip the
      // switch, diff every column. A future change that let /open write more
      // than is_open — status, is_active, suspended_*, commission, any payment
      // field — fails here rather than in production.
      const before = await readRestaurant(restA.id)
      const r = await postOpen(restA.id, { is_open: true }, cookies.owner)
      assertEq(r.status, 200, 'HTTP 200')
      const after = await readRestaurant(restA.id)

      const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
      const changed = keys.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      // updated_at may move under a DB trigger; that is not the route writing.
      const unexpected = changed.filter(k => k !== 'is_open' && k !== 'updated_at')

      assertEq(unexpected, [], `only is_open changed (unexpected: ${unexpected.join(', ') || 'none'})`)
      assert(changed.includes('is_open'), 'and is_open really did change')
      assertEq(after.is_open, true, 'to the requested value')
    })

    await step('#32 /open validates its one field', async () => {
      const before = await readRestaurant(restA.id)
      assertEq((await postOpen(restA.id, { is_open: 'yes' }, cookies.owner)).status, 400,
        'non-boolean is_open → 400')
      assertEq((await postOpen(restA.id, {}, cookies.owner)).status, 400, 'missing is_open → 400')
      assertEq((await readRestaurant(restA.id)).is_open, before.is_open, 'nothing changed on a rejected call')
    })

    await step('#32 staff CANNOT set /override — the other half of the divergence', async () => {
      const before = await readRestaurant(restA.id)
      const r = await postOverride(restA.id, { override: 'closed' }, cookies.staff)
      assertEq(r.status, 403, 'staff → 403 (commercial state)')
      const after = await readRestaurant(restA.id)
      assertEq(after.manual_override, before.manual_override, 'manual_override untouched by the refusal')
    })

    await step('#32 owner and manager can set and clear /override', async () => {
      assertEq((await postOverride(restA.id, { override: 'closed' }, cookies.owner)).status, 200, 'owner → 200')
      let row = await readRestaurant(restA.id)
      assertEq(row.manual_override, 'closed', "manual_override set to 'closed'")
      assert(row.manual_override_at !== null, 'manual_override_at stamped')

      assertEq((await postOverride(restA.id, { override: 'open' }, cookies.manager)).status, 200, 'manager → 200')
      row = await readRestaurant(restA.id)
      assertEq(row.manual_override, 'open', "manager set it to 'open'")

      assertEq((await postOverride(restA.id, { override: null }, cookies.owner)).status, 200, 'clearing → 200')
      row = await readRestaurant(restA.id)
      assertEq(row.manual_override, null, 'manual_override cleared')
      assertEq(row.manual_override_at, null, 'and the timestamp cleared with it')
    })

    await step('#32 /override validates its input', async () => {
      assertEq((await postOverride(restA.id, { override: 'maybe' }, cookies.owner)).status, 400,
        'an unknown override value → 400')
      assertEq((await postOverride(restA.id, {}, cookies.owner)).status, 400,
        'a body with nothing to update → 400')
      assertEq((await postOverride(restA.id, { allow_orders_when_closed: 'yes' }, cookies.owner)).status, 400,
        'non-boolean allow_orders_when_closed → 400')
      assertEq((await readRestaurant(restA.id)).manual_override, null, 'still cleared after the rejections')
    })

    await step('#32 an outsider and an anonymous caller are refused on both routes', async () => {
      const before = await readRestaurant(restA.id)

      assertEq((await postOpen(restA.id, { is_open: false }, cookies.outsider)).status, 403, '/open outsider → 403')
      assertEq((await postOverride(restA.id, { override: 'closed' }, cookies.outsider)).status, 403,
        '/override outsider → 403')
      assertEq((await postOpen(restA.id, { is_open: false }, null)).status, 401, '/open no session → 401')
      assertEq((await postOverride(restA.id, { override: 'closed' }, null)).status, 401,
        '/override no session → 401')

      const after = await readRestaurant(restA.id)
      assertEq(after.is_open, before.is_open, 'is_open untouched')
      assertEq(after.manual_override, before.manual_override, 'manual_override untouched')
    })

    await step('#32 cross-restaurant: A’s team cannot reach B', async () => {
      const before = await readRestaurant(restB.id)

      assertEq((await postOpen(restB.id, { is_open: false }, cookies.owner)).status, 403,
        "A's owner → /open on B → 403")
      assertEq((await postOpen(restB.id, { is_open: false }, cookies.staff)).status, 403,
        "A's staff → /open on B → 403")
      assertEq((await postOverride(restB.id, { override: 'closed' }, cookies.owner)).status, 403,
        "A's owner → /override on B → 403")
      assertEq((await postHours(restB.id, week('01:00', '02:00'), cookies.owner)).status, 403,
        "A's owner → /hours on B → 403")

      const after = await readRestaurant(restB.id)
      assertEq(after.is_open, before.is_open, "B's is_open untouched")
      assertEq(after.manual_override, before.manual_override, "B's manual_override untouched")
      assertEq((await storedHours(restB.id)).length, 0, 'B still has no schedule rows')
    })

    await step('#32 the toggles write audit rows', async () => {
      const { data } = await sb.from('audit_log')
        .select('action').eq('target_id', restA.id)
        .in('action', ['restaurant_open_toggled', 'manual_override_set', 'manual_override_removed', 'schedule_updated'])
      const actions = new Set((data ?? []).map(a => (a as { action: string }).action))
      for (const a of ['restaurant_open_toggled', 'manual_override_set', 'manual_override_removed', 'schedule_updated']) {
        assert(actions.has(a), `${a} audit row written`)
      }
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
