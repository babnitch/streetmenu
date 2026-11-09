// D4 — the 07:00 WhatsApp to the admins: "N nouveaux événements trouvés".
//   - the text: count, singular / plural, cities biggest first, the link to
//     Admin → Événements → Trouvés cette nuit (FR + EN)
//   - counts last night's candidates still new (not ignored / deleted)
//   - sent once per run: a second call sends nothing
//   - a night with nothing new: no message (but the run is closed for it)
//   - one audit row per report
// Fake recipients (+999) and a fake sender: nobody real is messaged.

import { sb, testName, testPhone } from '../testkit/env'
import { assert, assertEq, step, finish, warn } from '../testkit/assert'
import { teardown, track } from '../testkit/ledger'
import { sendMorningReport, reportText, FOUND_URL } from '@/lib/discovery/report'
import { titleKey } from '@/lib/discovery/dedupe'

const SUITE = 'db-discovery-report'
const A = testName('city_a')
const B = testName('city_b')
const PHONES = [testPhone(62, 1), testPhone(62, 2)]

async function newRun(): Promise<string> {
  const { data, error } = await sb.from('event_discovery_runs').insert({ status: 'done' }).select('id').single()
  if (error) throw new Error(error.message)
  track('event_discovery_runs', data.id)
  return data.id as string
}

let seq = 0
async function cand(runId: string, city: string, over: Record<string, unknown> = {}): Promise<void> {
  seq++
  const title = testName(`rep_${seq}`)
  const { data, error } = await sb.from('event_candidates').insert({
    run_id: runId, source_key: `https://t.example/rep/${seq}#${runId}`, source_url: `https://t.example/rep/${seq}`, source_domain: 't.example',
    title, title_key: titleKey(title), start_date: '2099-01-01', city, ...over,
  }).select('id').single()
  if (error) throw new Error(error.message)
  track('event_candidates', data.id)
}

async function main(): Promise<void> {
  try {
    await step('the text', () => {
      const t = reportText({ Douala: 1, 'Yaoundé': 2 })
      assertEq(t.fr, `🔭 3 nouveaux événements trouvés cette nuit (Yaoundé 2, Douala 1).\nÀ vérifier : ${FOUND_URL}`, 'FR plural, biggest city first')
      assertEq(t.en, `🔭 3 new events found overnight (Yaoundé 2, Douala 1).\nTo review: ${FOUND_URL}`, 'EN plural')
      assertEq(reportText({ Douala: 1 }).fr.split('\n')[0], '🔭 1 nouvel événement trouvé cette nuit (Douala 1).', 'FR singular')
      assertEq(reportText({ Douala: 1 }).en.split('\n')[0], '🔭 1 new event found overnight (Douala 1).', 'EN singular')
      assert(FOUND_URL.endsWith('/admin/events?tab=found'), 'links to the tab')
    })

    const { error: missing } = await sb.from('event_candidates').select('id').limit(1)
    if (missing) { warn('discovery tables missing', 'run supabase-event-discovery.sql'); return }

    const sent: Array<{ to: string; message: string; relatedId: string }> = []
    const send = async (to: string, message: string, relatedId: string) => { sent.push({ to, message, relatedId }) }

    await step('a night with new events: one message per admin, once', async () => {
      const run = await newRun()
      await cand(run, A); await cand(run, A); await cand(run, B)
      await cand(run, A, { status: 'ignored' })
      await cand(run, B, { deleted_at: new Date().toISOString() })
      const r = await sendMorningReport({ runId: run, phones: PHONES, send })
      assertEq([r.found, r.sentTo], [3, 2], 'counts new ones only, to both admins')
      assertEq(sent.map(s => s.to).sort(), [...PHONES].sort(), 'each admin once')
      assert(sent.every(s => s.relatedId === run && (s.message.startsWith(`🔭 3 nouveaux événements trouvés cette nuit (${A} 2, ${B} 1)`) || s.message.startsWith(`🔭 3 new events found overnight (${A} 2, ${B} 1)`))), 'the text, in the admin\'s language')
      const { data } = await sb.from('event_discovery_runs').select('report_sent_at').eq('id', run).single()
      assert(!!data?.report_sent_at, 'run marked as reported')
      const again = await sendMorningReport({ runId: run, phones: PHONES, send })
      assertEq([again.runId, again.sentTo, sent.length], [null, 0, 2], 'second call sends nothing')
      const { count } = await sb.from('audit_log').select('id', { count: 'exact', head: true })
        .eq('action', 'event_discovery_report').contains('metadata', { run_id: run })
      assertEq(count, 1, 'one audit row')
    })

    await step('a night with nothing new: no message', async () => {
      const run = await newRun()
      await cand(run, A, { status: 'ignored' })
      const before = sent.length
      const r = await sendMorningReport({ runId: run, phones: PHONES, send })
      assertEq([r.found, r.sentTo, sent.length - before], [0, 0, 0], 'nothing sent')
      const { data } = await sb.from('event_discovery_runs').select('report_sent_at').eq('id', run).single()
      assert(!!data?.report_sent_at, 'run closed for the report anyway')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
    finish(SUITE)
  }
}

void main()
