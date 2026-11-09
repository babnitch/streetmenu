// Photo focus point over HTTP — before AND after supabase-photo-focus.sql.
//   Always: the home rows, the event list, « À la une » and the offers answer
//   200; replacing a photo works.
//   Before the SQL: saving only a focus point → 503 (clear message), the
//   organiser's form is never refused over it.
//   After the SQL:
//     - admin / owner / organiser set the focus ("x y" %), audited old → new;
//       a bad value → 400
//     - the public key reads it; /api/popular, « À la une » and the event list
//       carry it
//     - a new photo starts centred again
// Per-run test city.

import { sb, testName, getAnon } from '../testkit/env'
import { assert, assertEq, step, finish, warn } from '../testkit/assert'
import { api, adminCookie, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeEvent, futureDateISO } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-photo-focus'
const CITY = testName('city')
const P1 = 'https://example.com/t/focus1.jpg'
const P2 = 'https://example.com/t/focus2.jpg'

interface Body { ok?: boolean; error?: string; field?: string; changed?: string[] }

async function audit(action: string, id: string, field: string) {
  const { data } = await sb.from('audit_log').select('metadata, performed_by_type').eq('action', action).eq('target_id', id).order('created_at')
  return (data ?? []).filter(a => (a.metadata as Record<string, unknown>).field === field)
}

async function main(): Promise<void> {
  try {
    const admin = await adminCookie()
    const owner = await makeCustomer({ suiteNo: 65, name: 'Focus Owner' })
    const org = await makeCustomer({ suiteNo: 65, name: 'Focus Organiser' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'focus_rest', city: CITY, extra: { image_url: P1 } })
    const ev = await makeEvent({ organizerId: org.id, label: 'focus_event', city: CITY, isActive: true, date: futureDateISO(3), extra: { cover_photo: P1 } })
    const { error: missing } = await sb.from('restaurants').select('image_focus').limit(1)
    const ready = !missing

    await step('pages work either way', async () => {
      for (const path of ['/api/popular', '/api/events/listing', '/api/home/featured', '/api/offers/today']) {
        const r = await api(`${path}?city=${encodeURIComponent(CITY)}`)
        assertEq(r.status, 200, `${path} → 200`)
      }
      const r = await api<Body>(`/api/admin/restaurants/${rest.id}/photo`, { cookie: admin, body: { image_url: P2 } })
      assertEq(r.status, 200, 'replacing a photo works')
      await api(`/api/admin/restaurants/${rest.id}/photo`, { cookie: admin, body: { image_url: P1 } })
    })

    if (!ready) {
      await step('before the SQL: focus saves refused cleanly', async () => {
        const r = await api<Body>(`/api/admin/restaurants/${rest.id}/photo`, { cookie: admin, body: { image_focus: '20 80' } })
        assertEq([r.status, r.body.field], [503, 'focus'], 'admin focus → 503')
        const o = await api<Body>(`/api/restaurants/${rest.id}/image`, { cookie: customerCookie(owner), body: { image_focus: '20 80' } })
        assertEq(o.status, 503, 'owner focus → 503')
        const p = await api(`/api/events/${ev.id}`, { method: 'PATCH', cookie: customerCookie(org), body: { cover_focus: '20 80', title: testName('focus_event_b') } })
        assertEq(p.status, 200, 'organiser form saves (focus ignored)')
      })
      warn('photo focus columns missing', 'run supabase-photo-focus.sql, then re-run api-photo-focus for the full checks')
      return
    }

    await step('admin: restaurant cover focus, audited, read everywhere', async () => {
      assertEq((await api<Body>(`/api/admin/restaurants/${rest.id}/photo`, { cookie: admin, body: { image_focus: '200 1' } })).body.field, 'image_focus', 'bad value → 400')
      const r = await api<Body>(`/api/admin/restaurants/${rest.id}/photo`, { cookie: admin, body: { image_focus: '20 80' } })
      assertEq([r.status, r.body.changed], [200, ['image_focus']], 'saved')
      const a = await audit('restaurant_photo_changed', rest.id, 'image_focus')
      assertEq([(a[0]?.metadata as Record<string, unknown>)?.old ?? null, (a[0]?.metadata as Record<string, unknown>)?.new], [null, '20 80'], 'audited old → new')
      const { data: pub, error } = await getAnon().from('restaurants').select('id, image_focus, logo_focus').eq('id', rest.id).maybeSingle()
      assert(!error && pub?.image_focus === '20 80', `public key reads it (${error?.message ?? 'ok'})`)
      const pop = await api<{ restaurants: Array<{ id: string; image_focus?: string | null }> }>(`/api/popular?city=${encodeURIComponent(CITY)}`)
      assertEq(pop.body.restaurants.find(x => x.id === rest.id)?.image_focus, '20 80', 'home row carries it')
    })

    await step('owner: logo focus; a new cover starts centred', async () => {
      const l = await api<Body>(`/api/restaurants/${rest.id}/image`, { cookie: customerCookie(owner), body: { logo_url: P2, logo_focus: '0 50' } })
      assertEq(l.status, 200, 'logo + its focus')
      const n = await api<Body>(`/api/restaurants/${rest.id}/image`, { cookie: customerCookie(owner), body: { image_url: P2 } })
      assertEq(n.status, 200, 'new cover')
      const { data } = await sb.from('restaurants').select('image_focus, logo_focus').eq('id', rest.id).single()
      assertEq([data?.image_focus, data?.logo_focus], [null, '0 50'], 'cover focus reset, logo focus kept')
      const a = await audit('restaurant_photo_changed', rest.id, 'logo_focus')
      assertEq(a[0]?.performed_by_type, 'owner', 'audited as owner')
    })

    await step('events: admin poster focus → « À la une » + list; organiser too; new poster resets', async () => {
      const r = await api<Body>(`/api/admin/events/${ev.id}/photo`, { cookie: admin, body: { cover_focus: '50 10' } })
      assertEq([r.status, r.body.changed], [200, ['cover_focus']], 'admin saved')
      const feat = await api<{ item: { id: string; focus?: string | null } | null }>(`/api/home/featured?city=${encodeURIComponent(CITY)}`)
      assertEq([feat.body.item?.id, feat.body.item?.focus], [ev.id, '50 10'], '« À la une » carries it')
      const list = await api<{ events: Array<{ id: string; cover_focus?: string | null }> }>(`/api/events/listing?city=${encodeURIComponent(CITY)}`)
      assertEq(list.body.events.find(e => e.id === ev.id)?.cover_focus, '50 10', 'event list carries it')
      const bad = await api<Body>(`/api/events/${ev.id}`, { method: 'PATCH', cookie: customerCookie(org), body: { cover_focus: 'top' } })
      assertEq([bad.status, bad.body.field], [400, 'cover_focus'], 'organiser bad value → 400')
      assertEq((await api(`/api/events/${ev.id}`, { method: 'PATCH', cookie: customerCookie(org), body: { cover_focus: '50 90' } })).status, 200, 'organiser saved')
      const a = await audit('event_photo_changed', ev.id, 'cover_focus')
      assertEq(a.map(x => `${x.performed_by_type}:${(x.metadata as Record<string, unknown>).new}`).slice(-1), ['organiser:50 90'], 'audited as organiser')
      await api(`/api/events/${ev.id}`, { method: 'PATCH', cookie: customerCookie(org), body: { cover_photo: P2 } })
      const { data } = await sb.from('events').select('cover_photo, cover_focus').eq('id', ev.id).single()
      assertEq([data?.cover_photo, data?.cover_focus], [P2, null], 'new poster starts centred')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
    finish(SUITE)
  }
}

void main()
