// Finished events (Admin → Événements « Terminés », organiser « Terminés »,
// nightly completion).
//   - rule: finished = last day (end_date, else date) before today in
//     Africa/Douala; cancelled is never finished; completed always is
//   - the nightly job (through the cron route, as super admin) sets
//     event_status = 'completed' on finished events only — not a cancelled
//     one, not one still running — and writes one audit row
// Test events in a per-run test city.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie } from '../testkit/session'
import { makeEvent, futureDateISO } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'
import { isFinishedEvent } from '@/lib/eventDate'
import { todayInDouala } from '@/lib/weekend'

const SUITE = 'api-event-completion'
const daysAgo = (n: number) => { const d = new Date(`${todayInDouala()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }

async function main(): Promise<void> {
  try {
    await step('the rule', () => {
      const e = (date: string, end_date: string | null, event_status: string | null = 'upcoming') => ({ id: 'x', date, end_date, time: null, end_time: null, event_status })
      assert(isFinishedEvent(e('2026-10-29', null), '2026-10-30'), 'single day yesterday → finished')
      assert(!isFinishedEvent(e('2026-10-30', null), '2026-10-30'), 'today → not finished')
      assert(!isFinishedEvent(e('2026-10-20', '2026-10-30'), '2026-10-30'), 'multi-day ending today → not finished')
      assert(isFinishedEvent(e('2026-10-20', '2026-10-29'), '2026-10-30'), 'multi-day ended yesterday → finished')
      assert(!isFinishedEvent(e('2026-10-01', null, 'cancelled'), '2026-10-30'), 'cancelled → never finished')
      assert(isFinishedEvent(e('2026-12-01', null, 'completed'), '2026-10-30'), 'marked completed → finished')
    })

    await step('nightly job: completes finished events only, one audit row', async () => {
      const past = await makeEvent({ label: 'done_past', date: daysAgo(3) })
      const running = await makeEvent({ label: 'done_running', date: daysAgo(3), endDate: futureDateISO(2) })
      const cancelled = await makeEvent({ label: 'done_cancelled', date: daysAgo(3), extra: { event_status: 'cancelled' } })
      const future = await makeEvent({ label: 'done_future', date: futureDateISO(5) })
      const { count: before } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('action', 'events_completed_nightly')
      const r = await api<{ events?: { completed: number } }>('/api/admin/cleanup-expired', { method: 'POST', cookie: await adminCookie() })
      assertEq(r.status, 200, `cron route ran (${r.raw.slice(0, 120)})`)
      assert((r.body.events?.completed ?? 0) >= 1, 'reported a count')
      const { data } = await sb.from('events').select('id, event_status').in('id', [past.id, running.id, cancelled.id, future.id])
      const st = Object.fromEntries((data ?? []).map(x => [x.id, x.event_status]))
      assertEq([st[past.id], st[running.id], st[cancelled.id], st[future.id]], ['completed', 'upcoming', 'cancelled', 'upcoming'], 'only the finished one is completed')
      const { count: after } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('action', 'events_completed_nightly')
      assertEq((after ?? 0) - (before ?? 0), 1, 'one audit row for the run')
      const again = await api<{ events?: { completed: number } }>('/api/admin/cleanup-expired', { method: 'POST', cookie: await adminCookie() })
      const { data: d2 } = await sb.from('events').select('event_status').eq('id', past.id).single()
      assertEq([again.status, d2?.event_status], [200, 'completed'], 'a second run changes nothing for it')
    })

    await step('cron auth: no session, wrong or blank secret → 403', async () => {
      assertEq((await api('/api/admin/cleanup-expired')).status, 403, 'no auth → 403')
      assertEq((await api('/api/admin/cleanup-expired', { headers: { Authorization: 'Bearer undefined' } })).status, 403, '"Bearer undefined" → 403')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
