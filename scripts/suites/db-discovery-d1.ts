// D1 — the nightly discovery run against the database, with a FAKE website
// (no network): a test source on a made-up domain, its robots.txt, RSS feed
// and event pages served from memory, in this run's test city.
//   - start lists the feed's pages; step visits them and saves candidates
//     (facts only), then closes the run with one audit row
//   - nothing is published: no events row is created
//   - a second night: the same events are duplicates, nothing new
//   - an event already live (same title, city, dates) is skipped; a similar
//     title is kept but flagged "possible duplicate"
//   - past events, other cities, robots-refused pages, a paused source,
//     a redirect to Instagram: nothing saved
//   - the public key reads none of the discovery tables
// Before supabase-event-discovery.sql: a warning, nothing checked.

import { sb, testName, getAnon, RUN_ID } from '../testkit/env'
import { assert, assertEq, step, finish, warn } from '../testkit/assert'
import { makeEvent, futureDateISO, pastDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { startRun, runStep, type DiscoveryDeps, type FetchResult } from '@/lib/discovery/run'

const SUITE = 'db-discovery-d1'
const CITY = testName('city')
const DOMAIN = `t-${RUN_ID}.example`
const PAUSED_DOMAIN = `t-${RUN_ID}-paused.example`
const BASE = `https://${DOMAIN}`
// The live test event is "__t_<run>_live_gala__": shares 2 of its 3 words → possible duplicate.
const SIMILAR = `${RUN_ID} gala night show`
const ld = (o: unknown) => `<html><script type="application/ld+json">${JSON.stringify(o)}</script></html>`
const ev = (name: string, date: string, city = CITY, extra: Record<string, unknown> = {}) => ({
  '@context': 'https://schema.org', '@type': 'Event', name, startDate: `${date}T19:00:00+01:00`,
  location: { '@type': 'Place', name: 'Salle T', address: { addressLocality: city } },
  organizer: { '@type': 'Organization', name: 'Org T' }, offers: { price: 3000, priceCurrency: 'XAF' }, ...extra,
})

function fakeSite(pages: Record<string, string>, robots: string): DiscoveryDeps & { fetched: string[] } {
  const fetched: string[] = []
  return {
    fetched,
    async fetchText(url): Promise<FetchResult | null> {
      fetched.push(url)
      if (url === `${BASE}/robots.txt`) return { status: 200, text: robots, finalUrl: url }
      if (url === `${BASE}/fr/event/moved`) return { status: 200, text: ld(ev('Moved', futureDateISO(9))), finalUrl: 'https://www.instagram.com/p/x' }
      const body = pages[url]
      return body == null ? { status: 404, text: '', finalUrl: url } : { status: 200, text: body, finalUrl: url }
    },
    sleep: async () => {},
    cities: async () => [CITY],
    today: () => futureDateISO(0),
  }
}

async function tablesExist(): Promise<boolean> {
  const { error } = await sb.from('event_candidates').select('id').limit(1)
  return !error
}

async function main(): Promise<void> {
  try {
    if (!(await tablesExist())) {
      warn('discovery tables missing', 'run supabase-event-discovery.sql, then re-run db-discovery-d1')
      finish(SUITE)
      return
    }

    const live = await makeEvent({ label: 'live_gala', city: CITY, date: futureDateISO(12), isActive: true })
    const { data: srcs, error: srcErr } = await sb.from('event_discovery_sources').insert([
      { domain: DOMAIN, kind: 'rss', feed_url: `${BASE}/rss`, status: 'approved', terms_note: 'test' },
      { domain: PAUSED_DOMAIN, kind: 'rss', feed_url: `https://${PAUSED_DOMAIN}/rss`, status: 'paused', terms_note: 'test' },
    ]).select('id, domain')
    assert(!srcErr, `test sources (${srcErr?.message ?? 'ok'})`)
    for (const s of srcs ?? []) track('event_discovery_sources', s.id)
    const sourceIds = (srcs ?? []).map(s => s.id as string)

    const page = (slug: string) => `${BASE}/fr/event/${slug}`
    const rss = `<rss><channel>${['concert', 'tour', 'gala', 'gala-similar', 'past', 'elsewhere', 'private', 'moved', 'gone']
      .map(s => `<item><link>${page(s)}</link><category>Concert / Musique</category></item>`).join('')}
      <item><link>https://other.example/fr/event/x</link></item></channel></rss>`
    const site = fakeSite({
      [`${BASE}/rss`]: rss,
      [page('concert')]: ld(ev('Concert Test Alpha', futureDateISO(10))),
      [page('tour')]: ld({ '@graph': [{ '@type': 'EventSeries', name: 'Tour', subEvent: [
        ev('Tour Beta', futureDateISO(14)), ev('Tour Beta', futureDateISO(16)), ev('Tour Beta', futureDateISO(18), 'Bamenda'),
      ] }] }),
      [page('gala')]: ld(ev(live.title, futureDateISO(12))),
      [page('gala-similar')]: ld(ev(SIMILAR, futureDateISO(12))),
      [page('past')]: ld(ev('Old Show', pastDateISO(3))),
      [page('elsewhere')]: ld(ev('Far Show', futureDateISO(11), 'Bamenda')),
      [page('private')]: ld(ev('Private Show', futureDateISO(11))),
    }, 'User-agent: *\nDisallow: /fr/event/private\n')

    let runId = ''
    await step('night 1: start lists the pages, step saves candidates', async () => {
      const s = await startRun(site, { sourceIds })
      runId = s.runId
      track('event_discovery_runs', runId)
      assertEq([s.resumed, s.pagesListed], [false, 9], 'own-site pages listed, other site ignored')
      assert(!site.fetched.some(u => u.includes(PAUSED_DOMAIN)), 'paused source never read')
      let r = await runStep(site, { runId })
      for (let i = 0; i < 3 && !r.finished; i++) r = await runStep(site, { runId })
      assert(r.finished, 'run finished')
      const { data: pages } = await sb.from('event_discovery_pages').select('id, url, status, skip_reason').eq('run_id', runId)
      for (const p of pages ?? []) track('event_discovery_pages', p.id)
      const by = Object.fromEntries((pages ?? []).map(p => [p.url.split('/').pop(), `${p.status}${p.skip_reason ? `:${p.skip_reason}` : ''}`]))
      assertEq(by.private, 'skipped:robots', 'robots-refused page skipped')
      assert(!site.fetched.includes(page('private')), 'robots-refused page never fetched')
      assertEq(by.moved, 'failed:http_error', 'redirect to a blocked site not used')
      assertEq(by.gone, 'failed:http_404', 'missing page')
    })

    await step('candidates: facts only, nothing published', async () => {
      const { data: c } = await sb.from('event_candidates').select('*').eq('run_id', runId).order('start_date')
      for (const x of c ?? []) track('event_candidates', x.id)
      const titles = (c ?? []).map(x => `${x.title} ${x.start_date}`)
      assertEq(titles.sort(), [
        `Concert Test Alpha ${futureDateISO(10)}`, `Tour Beta ${futureDateISO(14)}`, `Tour Beta ${futureDateISO(16)}`,
        `${SIMILAR} ${futureDateISO(12)}`,
      ].sort(), 'new events only (not the live one, past, other city, refused)')
      const alpha = (c ?? []).find(x => x.title === 'Concert Test Alpha')!
      assertEq([alpha.city, alpha.start_time, alpha.venue, alpha.price_fcfa, alpha.organiser_name, alpha.category, alpha.status, alpha.source_domain],
        [CITY, '19:00', 'Salle T', 3000, 'Org T', 'Concert', 'new', DOMAIN], 'facts saved')
      const similar = (c ?? []).find(x => x.title === SIMILAR)!
      assertEq(similar.possible_duplicate_event_id, live.id, 'similar title flagged as possible duplicate')
      const { count } = await sb.from('events').select('id', { count: 'exact', head: true }).eq('city', CITY)
      assertEq(count, 1, 'no event created (only the test one)')
      const { data: run } = await sb.from('event_discovery_runs').select('status, candidates_new, duplicates_skipped').eq('id', runId).single()
      assertEq([run?.status, run?.candidates_new, run?.duplicates_skipped], ['done', 4, 1], 'run counters')
      const { data: audit } = await sb.from('audit_log').select('metadata').eq('action', 'event_discovery_nightly')
        .contains('metadata', { run_id: runId })
      assertEq(audit?.length, 1, 'one audit row for the run')
    })

    await step('night 2: same pages → duplicates, nothing new', async () => {
      const s = await startRun(site, { sourceIds })
      track('event_discovery_runs', s.runId)
      let r = await runStep(site, { runId: s.runId })
      for (let i = 0; i < 3 && !r.finished; i++) r = await runStep(site, { runId: s.runId })
      const { data: pages } = await sb.from('event_discovery_pages').select('id').eq('run_id', s.runId)
      for (const p of pages ?? []) track('event_discovery_pages', p.id)
      const { data: run } = await sb.from('event_discovery_runs').select('candidates_new, duplicates_skipped').eq('id', s.runId).single()
      assertEq([run?.candidates_new, run?.duplicates_skipped], [0, 5], 'all known')
    })

    await step('public key reads none of the discovery tables', async () => {
      const anon = getAnon()
      for (const t of ['event_candidates', 'event_discovery_runs', 'event_discovery_pages', 'event_discovery_sources', 'ai_usage']) {
        const r = await anon.from(t).select('id').limit(1)
        assert(!!r.error || (r.data ?? []).length === 0, `${t}: nothing (${r.error?.code ?? (r.data ?? []).length})`)
      }
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
