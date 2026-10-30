// Nightly: events whose last day is over (Africa/Douala) get event_status =
// 'completed' — never a cancelled one. One audit row per run. Called from the
// nightly cron (/api/admin/cleanup-expired). Idempotent.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { EVENT_DATE_COLUMNS, isFinishedEvent } from '@/lib/eventDate'
import { todayInDouala } from '@/lib/weekend'

export async function completeFinishedEvents(today: string = todayInDouala()): Promise<{ completed: number; ids: string[] }> {
  // Only rows that could be finished: not completed / cancelled, and whose
  // start is before today (the last day can't be earlier than the start).
  const { data, error } = await supabaseAdmin.from('events')
    .select(`id, event_status, ${EVENT_DATE_COLUMNS}`)
    .not('event_status', 'in', '(completed,cancelled)').lt('date', today).range(0, 4999)
  if (error) throw new Error(`[events] completion query failed: ${error.message}`)
  const ids = ((data ?? []) as unknown as Array<{ id: string; event_status: string | null; date: string; end_date: string | null }>)
    .filter(e => isFinishedEvent(e as never, today)).map(e => e.id)
  if (ids.length) {
    const { error: upErr } = await supabaseAdmin.from('events').update({ event_status: 'completed' })
      .in('id', ids).not('event_status', 'in', '(completed,cancelled)')
    if (upErr) throw new Error(`[events] completion update failed: ${upErr.message}`)
  }
  await writeAudit({
    action: 'events_completed_nightly', targetType: 'platform', targetId: '00000000-0000-0000-0000-000000000000',
    performedByType: 'system', metadata: { today, completed: ids.length, event_ids: ids.slice(0, 200) },
  })
  return { completed: ids.length, ids }
}
