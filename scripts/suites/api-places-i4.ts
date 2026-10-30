// I4 — Lieux (places to visit). A logged-in user (either mode) proposes a
// place → pending, invisible until an admin publishes it; the admin edits,
// publishes, hides. Public reads never carry admin_note, sources or who
// proposed. Uses the tests' made-up city so nothing shows in a real
// city's list. Every phone is +999.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { testName } from '../testkit/env'

const SUITE = 'api-places-i4'
const CITY = testName('city')   // the tests' made-up city (accepted on the test server only)

async function main(): Promise<void> {
  try {
    const user = await makeCustomer({ suiteNo: 95, name: 'Places User' })
    const uc = customerCookie(user)
    const admin = await adminCookie()
    const title = testName('place_i4')
    let id = ''

    await step('public list needs a city', async () => {
      assertEq((await api('/api/places')).status, 400, 'no city → 400')
      const r = await api<{ places: unknown[] }>(`/api/places?city=${CITY}`)
      assertEq(r.status, 200, 'city → 200')
    })

    await step('proposal: login required, checked, always pending', async () => {
      assertEq((await api('/api/places', { method: 'POST', body: { title_fr: title, city: CITY, category: 'museums' } })).status, 401, 'anonymous → 401')
      const bad = await api<{ field?: string }>('/api/places', { method: 'POST', cookie: uc, body: { title_fr: title, city: CITY, category: 'zoo' } })
      assertEq([bad.status, bad.body.field], [400, 'category'], 'unknown category → 400')
      const r = await api<{ id: string }>('/api/places', { method: 'POST', cookie: uc, body: {
        title_fr: title, city: CITY, category: 'museums', area: 'Centre', description_fr: 'Un musée.', status: 'active', admin_note: 'hack',
      } })
      assertEq(r.status, 200, `sent (${r.raw.slice(0, 80)})`)
      id = r.body.id
      track('places', id)
      const { data } = await sb.from('places').select('status, admin_note, submitted_by').eq('id', id).single()
      assertEq(data, { status: 'pending', admin_note: null, submitted_by: user.id }, 'pending; status/note from the user ignored')
      const dup = await api('/api/places', { method: 'POST', cookie: uc, body: { title_fr: title.toUpperCase(), city: CITY, category: 'museums' } })
      assertEq(dup.status, 409, 'same name + city → 409')
    })

    await step('pending: hidden from the public, previewable by admin', async () => {
      const list = await api<{ places: Array<{ id: string }> }>(`/api/places?city=${CITY}`)
      assert(!list.body.places.some(p => p.id === id), 'not in the public list')
      assertEq((await api(`/api/places/${id}`)).status, 404, 'public page → 404')
      assertEq((await api(`/api/places/${id}`, { cookie: uc })).status, 404, 'proposer can\'t open it either')
      const a = await api<{ place: { status: string } }>(`/api/places/${id}`, { cookie: admin })
      assertEq([a.status, a.body.place?.status], [200, 'pending'], 'admin preview')
    })

    await step('admin routes are admin-only', async () => {
      assertEq((await api('/api/admin/places', { cookie: uc })).status, 401, 'customer GET → 401')
      assertEq((await api(`/api/admin/places/${id}`, { method: 'PATCH', cookie: uc, body: { status: 'active' } })).status, 401, 'customer PATCH → 401')
    })

    await step('admin edits + publishes; public fields only', async () => {
      const r = await api(`/api/admin/places/${id}`, { method: 'PATCH', cookie: admin, body: {
        status: 'active', title_en: 'A museum', tip_fr: 'Fermé le lundi', admin_note: 'vérifié', sources: 'https://src.example',
      } })
      assertEq(r.status, 200, 'saved')
      const list = await api<{ places: Array<Record<string, unknown>> }>(`/api/places?city=${CITY}`)
      const p = list.body.places.find(x => x.id === id)
      assert(!!p, 'now in the public list')
      assertEq([p?.title_en, p?.tip_fr], ['A museum', 'Fermé le lundi'], 'edited fields shown')
      for (const k of ['admin_note', 'sources', 'submitted_by']) assert(!(k in (p ?? {})), `${k} not public`)
      const one = await api<{ place: Record<string, unknown> }>(`/api/places/${id}`)
      assertEq(one.status, 200, 'public page → 200')
      assert(!('admin_note' in one.body.place) && !('sources' in one.body.place), 'page has no admin fields')
      const all = await api<{ places: Array<{ id: string; admin_note: string; submitter: { phone: string } | null }> }>('/api/admin/places', { cookie: admin })
      const mine = all.body.places.find(x => x.id === id)
      assertEq([mine?.admin_note, mine?.submitter?.phone], ['vérifié', user.phone], 'admin list: note + who proposed')
    })

    await step('home row: pictures first (?pictures_first=1), /lieux stays A–Z', async () => {
      const mk = async (label: string, cover: string | null) => {
        const r = await api<{ place: { id: string } }>('/api/admin/places', { method: 'POST', cookie: admin, body: { title_fr: testName(label), city: CITY, category: 'museums', ...(cover ? { cover_url: cover } : {}) } })
        track('places', r.body.place?.id)
        return r.body.place.id
      }
      const a = await mk('pf_a_nophoto', null)
      const z = await mk('pf_z_photo', 'https://example.org/photo.jpg')
      const home = await api<{ places: Array<{ id: string }> }>(`/api/places?city=${CITY}&limit=10&pictures_first=1`)
      const order = home.body.places.map(p => p.id).filter(id => id === a || id === z)
      assertEq(order, [z, a], 'the one with a photo comes first')
      const plain = await api<{ places: Array<{ id: string }> }>(`/api/places?city=${CITY}`)
      assertEq(plain.body.places.map(p => p.id).filter(id => id === a || id === z), [a, z], '/lieux order unchanged (A–Z)')
    })

    await step('admin hides; admin creates', async () => {
      assertEq((await api(`/api/admin/places/${id}`, { method: 'PATCH', cookie: admin, body: { status: 'hidden' } })).status, 200, 'hidden')
      assertEq((await api(`/api/places/${id}`)).status, 404, 'hidden → 404')
      assertEq((await api(`/api/admin/places/${id}`, { method: 'PATCH', cookie: admin, body: { official_link: 'javascript:x' } })).status, 400, 'bad link → 400')
      const c = await api<{ place: { id: string; status: string } }>('/api/admin/places', { method: 'POST', cookie: admin, body: { title_fr: testName('place_i4_admin'), city: CITY, category: 'nature' } })
      assertEq([c.status, c.body.place?.status], [200, 'active'], 'admin create → published')
      track('places', c.body.place?.id)
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
