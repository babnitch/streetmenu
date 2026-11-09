// Event discovery, 07:00 Douala: "N nouveaux événements trouvés" to the
// admins on WhatsApp, with the link to Admin → Événements → Trouvés cette
// nuit. Only when last night's run found something still waiting. Sent once
// per run (event_discovery_runs.report_sent_at is claimed first). Audited.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { SITE_URL } from '@/lib/siteLinks'
import { alertAdmins, type AlertOptions } from '@/lib/adminAlerts'

const NIL = '00000000-0000-0000-0000-000000000000'
export const FOUND_URL = `${SITE_URL}/admin/events?tab=found`

/** "Yaoundé 2, Douala 1" — biggest first. */
function cityList(byCity: Record<string, number>): string {
  return Object.entries(byCity).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, n]) => `${c} ${n}`).join(', ')
}

export function reportText(byCity: Record<string, number>): { fr: string; en: string } {
  const n = Object.values(byCity).reduce((a, b) => a + b, 0)
  const cities = cityList(byCity)
  return {
    fr: `🔭 ${n} ${n > 1 ? 'nouveaux' : 'nouvel'} événement${n > 1 ? 's' : ''} trouvé${n > 1 ? 's' : ''} cette nuit (${cities}).\nÀ vérifier : ${FOUND_URL}`,
    en: `🔭 ${n} new event${n > 1 ? 's' : ''} found overnight (${cities}).\nTo review: ${FOUND_URL}`,
  }
}

export interface ReportResult { runId: string | null; found: number; sentTo: number }

export async function sendMorningReport(opts: AlertOptions & { runId?: string } = {}): Promise<ReportResult> {
  let q = supabaseAdmin.from('event_discovery_runs').select('id').is('report_sent_at', null)
    .gte('started_at', new Date(Date.now() - 24 * 3600_000).toISOString())
  if (opts.runId) q = q.eq('id', opts.runId)
  const { data: runs } = await q.order('started_at', { ascending: false }).limit(1)
  const run = runs?.[0]
  if (!run) return { runId: null, found: 0, sentTo: 0 }

  // Claim the run first: a second call (retry, overlap) sends nothing.
  const { data: claimed } = await supabaseAdmin.from('event_discovery_runs')
    .update({ report_sent_at: new Date().toISOString() }).eq('id', run.id).is('report_sent_at', null).select('id')
  if (!claimed?.length) return { runId: run.id, found: 0, sentTo: 0 }

  const { data: cands } = await supabaseAdmin.from('event_candidates').select('city')
    .eq('run_id', run.id).eq('status', 'new').is('deleted_at', null)
  const byCity: Record<string, number> = {}
  for (const c of cands ?? []) byCity[c.city as string] = (byCity[c.city as string] ?? 0) + 1
  const found = cands?.length ?? 0

  let sentTo = 0
  if (found > 0) {
    const t = reportText(byCity)
    sentTo = await alertAdmins(t.fr, t.en, run.id, opts)
  }
  await writeAudit({
    action: 'event_discovery_report', targetType: 'platform', targetId: NIL, performedByType: 'system',
    metadata: { run_id: run.id, found, by_city: byCity, sent_to: sentTo },
  })
  return { runId: run.id, found, sentTo }
}
