// Nightly event discovery (supabase-event-discovery.sql). Called by Supabase
// pg_cron through /api/internal/discover-events:
//   start  (01:00 Douala)       new run; reads each approved source's feed
//                                and lists its event pages to visit
//   step   (every 5 min, 01–03) visits up to 15 listed pages, keeps the
//                                facts of new events as candidates
//   report (07:00)               the admins' WhatsApp (D4)
//
// Rules: only sources an admin approved (event_discovery_sources), never a
// blocked site (lib/discovery/blocklist.ts), robots.txt read every night, one
// request a second per site at most (more if the site asks). Facts and links
// only. Nothing is published: candidates wait in Admin → Événements.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { getRefData } from '@/lib/refDataServer'
import { visibleCities } from '@/lib/cities'
import { todayInDouala } from '@/lib/weekend'
import { SITE_URL } from '@/lib/siteLinks'
import { isBlockedUrl } from './blocklist'
import { BOT_TOKEN, robotsFromResponse, type Robots } from './robots'
import { parseRssItems, extractJsonLdEvents, toFoundEvent, type FoundEvent } from './parse'
import { titleKey, classifyAgainst, DUPLICATE_SCORE, titleSimilarity } from './dedupe'

const NIL = '00000000-0000-0000-0000-000000000000'
const MAX_PAGES_PER_SOURCE = 200
const PAGES_PER_STEP = 15
const STEP_BUDGET_MS = 45_000
const PAGE_RETENTION_DAYS = 30

export const USER_AGENT = `${BOT_TOKEN}/1.0 (+${SITE_URL}/bot)`

export interface FetchResult { status: number; text: string; finalUrl: string }

export interface DiscoveryDeps {
  fetchText(url: string): Promise<FetchResult | null>
  sleep(ms: number): Promise<void>
  cities(): Promise<string[]>
  today(): string
}

export const liveDeps: DiscoveryDeps = {
  async fetchText(url) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5' },
        redirect: 'follow', signal: AbortSignal.timeout(15_000), cache: 'no-store',
      })
      const text = (await res.text()).slice(0, 3_000_000)
      return { status: res.status, text, finalUrl: res.url || url }
    } catch {
      return null
    }
  },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async cities() { await getRefData(); return visibleCities() },
  today: () => todayInDouala(),
}

interface Source { id: string; domain: string; kind: string; feed_url: string; status: string }

const sameSite = (url: string, domain: string): boolean => {
  try { return new URL(url).hostname.replace(/^www\./, '') === domain.replace(/^www\./, '') } catch { return false }
}
const pathOf = (url: string): string => { const u = new URL(url); return u.pathname + u.search }

// Robots + politeness for one site within one call.
class SiteGate {
  private robots = new Map<string, Robots>()
  private lastAt = new Map<string, number>()
  constructor(private deps: DiscoveryDeps) {}

  async may(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (isBlockedUrl(url)) return { ok: false, reason: 'blocked_site' }
    const u = new URL(url)
    let r = this.robots.get(u.host)
    if (!r) {
      const res = await this.fetchRaw(`${u.protocol}//${u.host}/robots.txt`)
      r = robotsFromResponse(res)
      this.robots.set(u.host, r)
    }
    return r.allows(pathOf(url)) ? { ok: true } : { ok: false, reason: 'robots' }
  }

  async get(url: string): Promise<FetchResult | null> {
    const gate = await this.may(url)
    if (!gate.ok) return null
    const res = await this.fetchRaw(url)
    // A redirect elsewhere (another site, a blocked one) is not followed up.
    if (res && (isBlockedUrl(res.finalUrl) || new URL(res.finalUrl).host.replace(/^www\./, '') !== new URL(url).host.replace(/^www\./, ''))) return null
    return res
  }

  private async fetchRaw(url: string): Promise<FetchResult | null> {
    const host = new URL(url).host
    const delayMs = Math.max(1000, (this.robots.get(host)?.crawlDelaySec ?? 0) * 1000)
    const last = this.lastAt.get(host)
    if (last != null) {
      const wait = last + delayMs - Date.now()
      if (wait > 0) await this.deps.sleep(wait)
    }
    this.lastAt.set(host, Date.now())
    return this.deps.fetchText(url)
  }
}

async function addRunErrors(runId: string, errors: string[]): Promise<void> {
  if (!errors.length) return
  const { data } = await supabaseAdmin.from('event_discovery_runs').select('errors').eq('id', runId).single()
  const prev = Array.isArray(data?.errors) ? (data!.errors as string[]) : []
  await supabaseAdmin.from('event_discovery_runs').update({ errors: [...prev, ...errors].slice(-100) }).eq('id', runId)
}

// ── start ────────────────────────────────────────────────────────────────────

export interface StartResult { runId: string; resumed: boolean; pagesListed: number; errors: string[] }

export async function startRun(deps: DiscoveryDeps = liveDeps, opts: { sourceIds?: string[] } = {}): Promise<StartResult> {
  const since = new Date(Date.now() - 12 * 3600_000).toISOString()
  const { data: running } = await supabaseAdmin.from('event_discovery_runs').select('id, started_at')
    .eq('status', 'running').order('started_at', { ascending: false })
  const fresh = (running ?? []).find(r => r.started_at >= since)
  const stale = (running ?? []).filter(r => r.started_at < since).map(r => r.id)
  if (stale.length) await supabaseAdmin.from('event_discovery_runs').update({ status: 'failed', finished_at: new Date().toISOString() }).in('id', stale)
  if (fresh && !opts.sourceIds) return { runId: fresh.id, resumed: true, pagesListed: 0, errors: [] }

  // The page list is temporary work data: dropped after 30 days.
  await supabaseAdmin.from('event_discovery_pages').delete()
    .lt('created_at', new Date(Date.now() - PAGE_RETENTION_DAYS * 86400_000).toISOString())

  const { data: run, error: runErr } = await supabaseAdmin.from('event_discovery_runs').insert({}).select('id').single()
  if (runErr || !run) throw new Error(`[discovery] run insert failed: ${runErr?.message}`)

  let q = supabaseAdmin.from('event_discovery_sources').select('id, domain, kind, feed_url, status')
    .eq('status', 'approved').is('deleted_at', null)
  if (opts.sourceIds) q = q.in('id', opts.sourceIds)
  const { data: sources } = await q
  const gate = new SiteGate(deps)
  const errors: string[] = []
  let listed = 0

  for (const s of (sources ?? []) as Source[]) {
    if (s.kind !== 'rss') { errors.push(`${s.domain}: no reader for ${s.kind} yet`); continue }
    if (!sameSite(s.feed_url, s.domain)) { errors.push(`${s.domain}: feed is on another site`); continue }
    const may = await gate.may(s.feed_url)
    if (!may.ok) { errors.push(`${s.domain}: feed refused (${may.reason})`); continue }
    const res = await gate.get(s.feed_url)
    if (!res || res.status !== 200) { errors.push(`${s.domain}: feed HTTP ${res?.status ?? 'error'}`); continue }
    const items = parseRssItems(res.text, s.domain).slice(0, MAX_PAGES_PER_SOURCE)
    if (!items.length) continue
    const { error } = await supabaseAdmin.from('event_discovery_pages').upsert(
      items.map(i => ({ run_id: run.id, source_id: s.id, url: i.url, domain: s.domain, category_hint: i.category })),
      { onConflict: 'run_id,url', ignoreDuplicates: true },
    )
    if (error) errors.push(`${s.domain}: page list ${error.message}`)
    else listed += items.length
  }
  await addRunErrors(run.id, errors)
  return { runId: run.id, resumed: false, pagesListed: listed, errors }
}

// ── step ─────────────────────────────────────────────────────────────────────

export interface StepResult {
  runId: string | null
  pages: number
  newCandidates: number
  duplicates: number
  finished: boolean
}

type Outcome = 'new' | 'duplicate' | 'skipped'

async function saveFound(f: FoundEvent, page: { url: string; domain: string }, runId: string, today: string): Promise<Outcome> {
  const lastDay = f.end_date ?? f.start_date
  if (lastDay < today) return 'skipped'
  const sourceKey = `${page.url}#${f.start_date}#${f.city}`

  const { data: same } = await supabaseAdmin.from('event_candidates').select('id').eq('source_key', sourceKey).limit(1)
  if (same?.length) return 'duplicate'

  // Already a live event (rejected = deleted, never counts)?
  const { data: events } = await supabaseAdmin.from('events').select('id, title')
    .eq('city', f.city).lte('date', lastDay).gte('effective_end_date', f.start_date)
    .neq('event_status', 'rejected').limit(200)
  const verdict = classifyAgainst(f.title, (events ?? []) as Array<{ id: string; title: string }>)
  if (verdict.kind === 'duplicate') return 'duplicate'

  // The same event found under another link (another site, another page).
  const { data: cands } = await supabaseAdmin.from('event_candidates').select('id, title, source_url, other_urls')
    .eq('city', f.city).lte('start_date', lastDay).gte('start_date', f.start_date).is('deleted_at', null).limit(200)
  const twin = (cands ?? []).find(c => titleSimilarity(f.title, c.title as string) >= DUPLICATE_SCORE)
  if (twin) {
    const others = (twin.other_urls as string[] | null) ?? []
    if (twin.source_url !== page.url && !others.includes(page.url)) {
      await supabaseAdmin.from('event_candidates').update({ other_urls: [...others, page.url].slice(0, 10) }).eq('id', twin.id)
    }
    return 'duplicate'
  }

  const { error } = await supabaseAdmin.from('event_candidates').insert({
    run_id: runId, source_key: sourceKey, source_url: page.url, source_domain: page.domain,
    ticket_url: f.ticket_url, title: f.title, title_key: titleKey(f.title),
    start_date: f.start_date, start_time: f.start_time, end_date: f.end_date, end_time: f.end_time,
    venue: f.venue, city: f.city, category: f.category, price_fcfa: f.price_fcfa, price_is_from: f.price_is_from,
    organiser_name: f.organiser_name, organiser_url: f.organiser_url,
    possible_duplicate_event_id: verdict.kind === 'possible' ? verdict.id : null,
  })
  if (error) {
    if (error.code === '23505') return 'duplicate'
    throw new Error(`candidate insert failed: ${error.message}`)
  }
  return 'new'
}

export async function runStep(deps: DiscoveryDeps = liveDeps, opts: { runId?: string; budgetMs?: number } = {}): Promise<StepResult> {
  const t0 = Date.now()
  const budget = opts.budgetMs ?? STEP_BUDGET_MS
  let runQ = supabaseAdmin.from('event_discovery_runs').select('id, pages_fetched, candidates_new, duplicates_skipped').eq('status', 'running')
  if (opts.runId) runQ = runQ.eq('id', opts.runId)
  const { data: runs } = await runQ.order('started_at', { ascending: false }).limit(1)
  const run = runs?.[0]
  if (!run) return { runId: null, pages: 0, newCandidates: 0, duplicates: 0, finished: false }

  const { data: pages } = await supabaseAdmin.from('event_discovery_pages').select('id, url, domain, source_id, category_hint')
    .eq('run_id', run.id).eq('status', 'pending').order('created_at').limit(PAGES_PER_STEP)
  const sourceIds = Array.from(new Set((pages ?? []).map(p => p.source_id).filter(Boolean)))
  const { data: sources } = sourceIds.length
    ? await supabaseAdmin.from('event_discovery_sources').select('id, domain, status').in('id', sourceIds).is('deleted_at', null)
    : { data: [] }
  const approved = new Map((sources ?? []).filter(s => s.status === 'approved').map(s => [s.id as string, s.domain as string]))

  const cities = await deps.cities()
  const today = deps.today()
  const gate = new SiteGate(deps)
  const errors: string[] = []
  let fetched = 0, added = 0, dups = 0

  for (const p of pages ?? []) {
    if (Date.now() - t0 > budget) break
    const mark = (status: string, skip_reason: string | null = null) =>
      supabaseAdmin.from('event_discovery_pages').update({ status, skip_reason }).eq('id', p.id)
    const domain = approved.get(p.source_id as string)
    if (!domain || !sameSite(p.url, domain)) { await mark('skipped', 'source_not_approved'); continue }
    const may = await gate.may(p.url)
    if (!may.ok) { await mark('skipped', may.reason); continue }
    const res = await gate.get(p.url)
    fetched++
    if (!res || res.status !== 200) { await mark('failed', `http_${res?.status ?? 'error'}`); continue }
    try {
      for (const ev of extractJsonLdEvents(res.text)) {
        const f = toFoundEvent(ev, p.url, p.category_hint as string | null, cities)
        if (!f) continue
        const outcome = await saveFound(f, { url: p.url, domain }, run.id, today)
        if (outcome === 'new') added++
        else if (outcome === 'duplicate') dups++
      }
      await mark('done')
    } catch (e) {
      errors.push(`${p.url}: ${(e as Error).message}`)
      await mark('failed', 'save_error')
    }
  }

  await supabaseAdmin.from('event_discovery_runs').update({
    pages_fetched: (run.pages_fetched as number) + fetched,
    candidates_new: (run.candidates_new as number) + added,
    duplicates_skipped: (run.duplicates_skipped as number) + dups,
  }).eq('id', run.id)
  await addRunErrors(run.id, errors)

  const { count: left } = await supabaseAdmin.from('event_discovery_pages').select('id', { count: 'exact', head: true })
    .eq('run_id', run.id).eq('status', 'pending')
  let finished = false
  if (!left) {
    const { data: done } = await supabaseAdmin.from('event_discovery_runs')
      .update({ status: 'done', finished_at: new Date().toISOString() })
      .eq('id', run.id).eq('status', 'running')
      .select('pages_fetched, candidates_new, duplicates_skipped, errors')
    finished = true
    if (done?.length) {
      const d = done[0]
      await writeAudit({
        action: 'event_discovery_nightly', targetType: 'platform', targetId: NIL, performedByType: 'system',
        metadata: { run_id: run.id, pages: d.pages_fetched, new: d.candidates_new, duplicates: d.duplicates_skipped, errors: (d.errors as unknown[]).length },
      })
    }
  }
  return { runId: run.id, pages: fetched, newCandidates: added, duplicates: dups, finished }
}
