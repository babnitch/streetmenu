// Nightly: events whose last day is over (Africa/Douala) get event_status =
// 'completed' — never a cancelled one. One audit row per run. Called from the
// nightly cron (/api/admin/cleanup-expired). Idempotent.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { EVENT_DATE_COLUMNS, isFinishedEvent } from '@/lib/eventDate'
import { todayInDouala } from '@/lib/weekend'

// opts.onlyIds limits the run to those events (tests: never touch real rows).
// UPDATE only — never erases a row; rejected / cancelled are left as they are.
export async function completeFinishedEvents(today: string = todayInDouala(), opts: { onlyIds?: string[] } = {}): Promise<{ completed: number; ids: string[] }> {
  // Only rows that could be finished: not completed / cancelled, and whose
  // start is before today (the last day can't be earlier than the start).
  let q = supabaseAdmin.from('events')
    .select(`id, event_status, ${EVENT_DATE_COLUMNS}`)
    .not('event_status', 'in', '(completed,cancelled,rejected)').lt('date', today)
  if (opts.onlyIds) q = q.in('id', opts.onlyIds)
  const { data, error } = await q.range(0, 4999)
  if (error) throw new Error(`[events] completion query failed: ${error.message}`)
  const ids = ((data ?? []) as unknown as Array<{ id: string; event_status: string | null; date: string; end_date: string | null }>)
    .filter(e => isFinishedEvent(e as never, today)).map(e => e.id)
  if (ids.length) {
    const { error: upErr } = await supabaseAdmin.from('events').update({ event_status: 'completed' })
      .in('id', ids).not('event_status', 'in', '(completed,cancelled,rejected)')
    if (upErr) throw new Error(`[events] completion update failed: ${upErr.message}`)
  }
  if (opts.onlyIds) return { completed: ids.length, ids }
  await writeAudit({
    action: 'events_completed_nightly', targetType: 'platform', targetId: '00000000-0000-0000-0000-000000000000',
    performedByType: 'system', metadata: { today, completed: ids.length, event_ids: ids.slice(0, 200) },
  })
  return { completed: ids.length, ids }
}
