// Event discovery over HTTP.
//   D1: the nightly route (/api/internal/discover-events) only answers the
//       internal secret — no secret, a wrong one, an admin cookie: refused;
//       an unknown step: 400 (never runs anything).
//   D2: « Trouvés cette nuit »
//     - the list: admins and moderators; new + contacted only (not ignored,
//       published or deleted), with the possible-duplicate title
//     - contacted / ignore (with a reason): admins only, audited; a handled
//       or deleted candidate can't be changed
//     - publish = the admin create with candidate_id: info only, the ticket
//       link, NO poster even if one is sent; the candidate is linked and
//       audited; a second publish is refused
// Per-run test city; candidates written straight to the table.

import { sb, testName, RUN_ID } from '../testkit/env'
import { assertEq, assert, step, finish, warn } from '../testkit/assert'
import { api, adminCookie, customerCookie, staffCookie } from '../testkit/session'
import { makeCustomer, makeEvent, futureDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { titleKey } from '@/lib/discovery/dedupe'
import { organiserMessage, candidateToForm, type EventCandidate } from '@/lib/discovery/candidates'

const SUITE = 'api-discovery'
const ROUTE = '/api/internal/discover-events'
const CITY = testName('city')

interface ListBody { candidates?: EventCandidate[] }
interface EventBody { ok?: boolean; error?: string; event?: { id: string } }

let seq = 0
async function candidate(over: Record<string, unknown> = {}): Promise<string> {
  seq++
  const title = (over.title as string) ?? testName(`cand_${seq}`)
  const { data, error } = await sb.from('event_candidates').insert({
    source_key: `https://t-${RUN_ID}.example/e/${seq}#x`, source_url: `https://t-${RUN_ID}.example/e/${seq}`,
    source_domain: `t-${RUN_ID}.example`, ticket_url: `https://t-${RUN_ID}.example/e/${seq}`,
    title, title_key: titleKey(title), start_date: futureDateISO(10 + seq), start_time: '19:00', venue: 'Salle T',
    city: CITY, category: 'Concert', price_fcfa: 2000, price_is_from: true, organiser_name: 'Org T', ...over,
  }).select('id').single()
  if (error) throw new Error(error.message)
  track('event_candidates', data.id)
  return data.id as string
}

async function auditCount(action: string, id: string): Promise<number> {
  const { count } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('action', action).eq('target_id', id)
  return count ?? 0
}

async function main(): Promise<void> {
  try {
    await step('D1: nightly route needs the internal secret', async () => {
      const post = (headers: Record<string, string>, cookie?: string) =>
        api(ROUTE, { method: 'POST', headers, cookie, body: { step: 'nope' } })
      const none = await post({})
      assert([401, 503].includes(none.status), `no secret → refused (${none.status})`)
      assert([401, 503].includes((await post({ Authorization: 'Bearer wrong' })).status), 'wrong secret → refused')
      assert([401, 503].includes((await post({}, await adminCookie())).status), 'admin cookie is not enough')
      const secret = process.env.INTERNAL_API_SECRET
      if (secret) assertEq((await post({ Authorization: `Bearer ${secret}` })).status, 400, 'right secret, unknown step → 400')
    })

    const { error: missing } = await sb.from('event_candidates').select('id').limit(1)
    if (missing) {
      warn('discovery tables missing', 'run supabase-event-discovery.sql, then re-run api-discovery')
      return
    }

    const admin = await adminCookie()
    const cust = await makeCustomer({ suiteNo: 61, name: 'Disc Customer' })
    const moderator = staffCookie({ id: cust.id, email: 'm@test.invalid', name: 'Mod', role: 'moderator' })
    const live = await makeEvent({ label: 'disc_live', city: CITY, date: futureDateISO(30) })
    const a = await candidate({ possible_duplicate_event_id: live.id })
    const b = await candidate()
    const c = await candidate()
    const ignored = await candidate({ status: 'ignored' })
    const deleted = await candidate({ deleted_at: new Date().toISOString() })

    await step('D2: the list', async () => {
      assertEq((await api('/api/admin/event-candidates')).status, 401, 'no session → 401')
      assertEq((await api('/api/admin/event-candidates', { cookie: customerCookie(cust) })).status, 401, 'customer → 401')
      const r = await api<ListBody>('/api/admin/event-candidates', { cookie: moderator })
      assertEq(r.status, 200, 'moderator can look')
      const mine = (r.body.candidates ?? []).filter(x => x.city === CITY)
      assertEq(mine.map(x => x.id).sort(), [a, b, c].sort(), 'new ones only (not ignored / deleted)')
      assertEq(mine.find(x => x.id === a)?.possible_duplicate_title, live.title, 'possible duplicate title')
    })

    await step('D2: contacted / ignore', async () => {
      assertEq((await api(`/api/admin/event-candidates/${a}`, { cookie: moderator, body: { action: 'contacted' } })).status, 401, 'moderator cannot act')
      const r = await api(`/api/admin/event-candidates/${a}`, { cookie: admin, body: { action: 'contacted', lang: 'en', channel: 'page' } })
      assertEq(r.status, 200, 'contacted')
      const { data } = await sb.from('event_candidates').select('status, contacted_at').eq('id', a).single()
      assert(data?.status === 'contacted' && !!data.contacted_at, 'saved')
      assertEq(await auditCount('event_candidate_contacted', a), 1, 'audited')
      assertEq((await api(`/api/admin/event-candidates/${b}`, { cookie: admin, body: { action: 'ignore' } })).status, 400, 'ignore needs a reason')
      assertEq((await api(`/api/admin/event-candidates/${b}`, { cookie: admin, body: { action: 'ignore', reason: 'duplicate' } })).status, 200, 'ignored')
      const { data: ib } = await sb.from('event_candidates').select('status, ignore_reason').eq('id', b).single()
      assertEq([ib?.status, ib?.ignore_reason], ['ignored', 'duplicate'], 'saved with reason')
      assertEq(await auditCount('event_candidate_ignored', b), 1, 'audited')
      assertEq((await api(`/api/admin/event-candidates/${b}`, { cookie: admin, body: { action: 'contacted' } })).status, 409, 'ignored → cannot be changed')
      assertEq((await api(`/api/admin/event-candidates/${ignored}`, { cookie: admin, body: { action: 'ignore', reason: 'other' } })).status, 409, 'already ignored → 409')
      assertEq((await api(`/api/admin/event-candidates/${deleted}`, { cookie: admin, body: { action: 'contacted' } })).status, 404, 'deleted → 404')
      assertEq((await api(`/api/admin/event-candidates/${c}`, { cookie: admin, body: { action: 'nope' } })).status, 400, 'unknown action → 400')
    })

    await step('D2: publish as info only, no poster', async () => {
      const { data: cand } = await sb.from('event_candidates').select('*').eq('id', a).single()
      const form = candidateToForm(cand as EventCandidate)
      const r = await api<EventBody>('/api/admin/events', { cookie: admin, body: { ...form, candidate_id: a, cover_photo: 'https://example.com/poster.jpg' } })
      assertEq(r.status, 200, `published (${r.raw.slice(0, 100)})`)
      const eid = r.body.event!.id
      track('events', eid)
      const { data: ev } = await sb.from('events').select('title, city, date, time, venue, price, price_is_from, booking_mode, info_link, cover_photo, managed_by_platform, is_active, organizer_name').eq('id', eid).single()
      assertEq(ev, {
        title: cand!.title, city: CITY, date: cand!.start_date, time: '19:00', venue: 'Salle T', price: 2000, price_is_from: true,
        booking_mode: 'info', info_link: cand!.ticket_url, cover_photo: null, managed_by_platform: true, is_active: true, organizer_name: 'Org T',
      }, 'info only, ticket link, no poster')
      const { data: after } = await sb.from('event_candidates').select('status, published_event_id').eq('id', a).single()
      assertEq([after?.status, after?.published_event_id], ['published', eid], 'candidate linked')
      assertEq(await auditCount('event_candidate_published', a), 1, 'candidate audit')
      const { data: evAudit } = await sb.from('audit_log').select('metadata').eq('action', 'event_created_by_admin').eq('target_id', eid).single()
      assertEq((evAudit?.metadata as Record<string, unknown>)?.origin, 'candidate', 'event audit says where it came from')
      const again = await api<EventBody>('/api/admin/events', { cookie: admin, body: { ...form, candidate_id: a } })
      assertEq(again.status, 409, 'second publish refused')
      const gone = await api<EventBody>('/api/admin/events', { cookie: admin, body: { ...form, candidate_id: deleted } })
      assertEq(gone.status, 404, 'deleted candidate → 404')
    })

    await step('D2: organiser message', () => {
      const m = { title: 'Gala', organiser_name: 'Org', start_date: '2026-12-13', start_time: '18:00', end_date: null, end_time: null, venue: 'Hall', city: 'Douala' }
      const fr = organiserMessage(m, 'fr'), en = organiserMessage(m, 'en')
      assert(fr.startsWith('Bonjour Org') && fr.includes('« Gala »') && fr.includes('à Hall') && fr.includes('OUI AFFICHE'), 'FR')
      assert(en.startsWith('Hello Org') && en.includes('"Gala"') && en.includes('YES POSTER'), 'EN')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
    finish(SUITE)
  }
}

void main()
