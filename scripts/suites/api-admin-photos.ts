// Admin changes the photos of EXISTING restaurants and events.
//   - restaurants: cover (image_url) + logo (logo_url) replaced / removed,
//     optional credit; admin + super admin only; the blur placeholder follows
//     the photo shown; one audit row restaurant_photo_changed per field with
//     the old and new value; a deleted restaurant can't be changed
//   - events (managed or an organiser's): poster (cover_photo) + credit, audit
//     event_photo_changed; a rejected event can't be changed
//   - at once: the home row puts the restaurant with a real photo first, the
//     « À la une » fallback picks the event once it has a poster (with credit)
//   - the public key reads photo_credit
//   - owners (Mon compte) and organisers (Mes événements) still change their
//     own photos; a new photo drops the old credit and blur placeholder
// Per-run test city; photo URLs are fixed test URLs (no upload).

import { sb, testName, getAnon } from '../testkit/env'
import { assert, assertEq, step, finish, warn } from '../testkit/assert'
import { api, adminCookie, customerCookie, staffCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeEvent, futureDateISO } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'
import { checkPhotoBody, blurFor } from '@/lib/adminPhotos'

const SUITE = 'api-admin-photos'
const CITY = testName('city')
const P1 = 'https://example.com/t/photo1.jpg'
const P2 = 'https://example.com/t/photo2.jpg'
const LOGO = 'https://example.com/t/logo.png'

interface PhotoBody { ok?: boolean; error?: string; field?: string; changed?: string[]; restaurant?: Record<string, unknown>; event?: Record<string, unknown> }

async function audits(action: string, id: string): Promise<Array<{ metadata: Record<string, unknown> }>> {
  const { data } = await sb.from('audit_log').select('metadata').eq('action', action).eq('target_id', id).order('created_at')
  return (data ?? []) as Array<{ metadata: Record<string, unknown> }>
}

async function main(): Promise<void> {
  try {
    await step('the checks (no database)', () => {
      assertEq(checkPhotoBody({ image_url: P1, logo_url: null }, ['image_url', 'logo_url']), { ok: true, patch: { image_url: P1, logo_url: null } }, 'replace + remove')
      assertEq(checkPhotoBody({ image_url: 'javascript:x' }, ['image_url']).ok, false, 'bad URL refused')
      assertEq(checkPhotoBody({ cover_photo: P1 }, ['image_url']).ok, false, 'a field this row lacks is ignored → nothing to change')
      assertEq(checkPhotoBody({ photo_credit: '  Page  Facebook ' }, []), { ok: true, patch: { photo_credit: 'Page Facebook' } }, 'credit tidied')
      assertEq(checkPhotoBody({ photo_credit: '' }, []), { ok: true, patch: { photo_credit: null } }, 'empty credit removes it')
      assertEq(checkPhotoBody({ photo_credit: 'x'.repeat(121) }, []).ok, false, 'credit too long')
      assertEq(blurFor(P1, P1, 'abc'), {}, 'same photo → blur kept')
      assertEq(blurFor(P1, P2, 'abc'), { blur_hash: 'abc' }, 'new photo → its blur')
      assertEq(blurFor(P1, P2, undefined), { blur_hash: null }, 'new photo without blur → none (never the old one)')
      assertEq(blurFor(P1, null, 'abc'), { blur_hash: null }, 'removed → none')
    })

    const { error: missing } = await sb.from('restaurants').select('photo_credit').limit(1)
    if (missing) { warn('photo_credit column missing', 'run supabase-photo-credit.sql, then re-run api-admin-photos'); return }

    const admin = await adminCookie()
    const owner = await makeCustomer({ suiteNo: 63, name: 'Photo Owner' })
    const stranger = await makeCustomer({ suiteNo: 63, name: 'Photo Stranger' })
    const moderator = staffCookie({ id: stranger.id, email: 'm@test.invalid', name: 'Mod', role: 'moderator' })
    const older = await makeRestaurant({ ownerId: owner.id, label: 'photo_older', city: CITY })
    const newer = await makeRestaurant({ label: 'photo_newer', city: CITY })
    const R = (id: string) => `/api/admin/restaurants/${id}/photo`

    await step('restaurant: who may', async () => {
      assertEq((await api(R(older.id), { body: { image_url: P1 } })).status, 401, 'no session')
      assertEq((await api(R(older.id), { cookie: customerCookie(owner), body: { image_url: P1 } })).status, 401, 'owner cannot use the admin route')
      assertEq((await api(R(older.id), { cookie: moderator, body: { image_url: P1 } })).status, 401, 'moderator cannot')
      assertEq((await api(R(older.id), { cookie: admin, body: {} })).status, 400, 'nothing to change → 400')
      const bad = await api<PhotoBody>(R(older.id), { cookie: admin, body: { image_url: 'ftp://x' } })
      assertEq([bad.status, bad.body.field], [400, 'image_url'], 'bad URL → 400')
    })

    await step('home row: real photo first, at once', async () => {
      const ids = async () => ((await api<{ restaurants: Array<{ id: string }> }>(`/api/popular?city=${encodeURIComponent(CITY)}`)).body.restaurants ?? []).map(x => x.id)
      const before = await ids()
      assertEq(before.slice(0, 2), [newer.id, older.id], 'no photos: newest first')
      const r = await api<PhotoBody>(R(older.id), { cookie: admin, body: { image_url: P1, blur_hash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH' } })
      assertEq(r.status, 200, `cover set (${r.raw.slice(0, 80)})`)
      assertEq((await ids())[0], older.id, 'with a photo: first')
    })

    await step('restaurant: replace, logo, credit, remove — audited', async () => {
      const { data: d1 } = await sb.from('restaurants').select('image_url, blur_hash').eq('id', older.id).single()
      assertEq([d1?.image_url, d1?.blur_hash], [P1, 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH'], 'cover + its blur saved')
      await api(R(older.id), { cookie: admin, body: { image_url: P2 } })
      const { data: d2 } = await sb.from('restaurants').select('image_url, blur_hash').eq('id', older.id).single()
      assertEq([d2?.image_url, d2?.blur_hash], [P2, null], 'replaced; old blur never kept')
      const lc = await api<PhotoBody>(R(older.id), { cookie: admin, body: { logo_url: LOGO, photo_credit: 'Page Facebook du restaurant, avec accord' } })
      assertEq(lc.body.changed?.sort(), ['logo_url', 'photo_credit'], 'logo + credit')
      const same = await api<PhotoBody>(R(older.id), { cookie: admin, body: { logo_url: LOGO } })
      assertEq(same.body.changed, [], 'same value → nothing written')
      await api(R(older.id), { cookie: admin, body: { image_url: null } })
      const { data: d3 } = await sb.from('restaurants').select('image_url, logo_url, photo_credit').eq('id', older.id).single()
      assertEq([d3?.image_url, d3?.logo_url, d3?.photo_credit], [null, LOGO, 'Page Facebook du restaurant, avec accord'], 'cover removed, logo + credit kept')
      const rows = await audits('restaurant_photo_changed', older.id)
      const key = (a: { metadata: Record<string, unknown> }) => `${a.metadata.field}:${a.metadata.old ?? '-'}>${a.metadata.new ?? '-'}`
      assertEq(rows.map(key).sort(), [
        `image_url:->${P1}`, `image_url:${P1}>${P2}`, `logo_url:->${LOGO}`, 'photo_credit:->Page Facebook du restaurant, avec accord', `image_url:${P2}>-`,
      ].sort(), 'one audit row per change, old → new')
      assertEq(rows.length, 5, 'five changes, five rows')
    })

    await step('public key reads the credit', async () => {
      const { data, error } = await getAnon().from('restaurants').select('id, photo_credit').eq('id', older.id).maybeSingle()
      assert(!error, `readable (${error?.message ?? 'ok'})`)
      assertEq(data?.photo_credit, 'Page Facebook du restaurant, avec accord', 'credit public')
    })

    await step('owner (Mon compte) still changes their photo; credit + blur reset', async () => {
      assertEq((await api(`/api/restaurants/${older.id}/image`, { cookie: customerCookie(stranger), body: { image_url: P1 } })).status, 403, 'not the owner → 403')
      const r = await api(`/api/restaurants/${older.id}/image`, { cookie: customerCookie(owner), body: { image_url: P1 } })
      assertEq(r.status, 200, 'owner saved')
      const { data } = await sb.from('restaurants').select('image_url, photo_credit, blur_hash').eq('id', older.id).single()
      assertEq([data?.image_url, data?.photo_credit, data?.blur_hash], [P1, null, null], 'new photo, old credit + blur gone')
    })

    await step('deleted restaurant: locked', async () => {
      const gone = await makeRestaurant({ label: 'photo_gone', city: CITY, extra: { deleted_at: new Date().toISOString() } })
      assertEq((await api(R(gone.id), { cookie: admin, body: { image_url: P1 } })).status, 404, 'deleted → 404')
    })

    const org = await makeCustomer({ suiteNo: 63, name: 'Photo Organiser' })
    const ev = await makeEvent({ organizerId: org.id, label: 'photo_event', city: CITY, isActive: true, date: futureDateISO(4) })
    const E = `/api/admin/events/${ev.id}/photo`

    await step('event: poster + credit, « À la une » fallback at once', async () => {
      const feat = async () => (await api<{ item: { id: string; image: string | null; credit: string | null } | null }>(`/api/home/featured?city=${encodeURIComponent(CITY)}`)).body.item
      const before = await feat()
      assert(!before || before.id !== ev.id, 'no poster → not « À la une »')
      assertEq((await api(E, { cookie: customerCookie(org), body: { cover_photo: P1 } })).status, 401, 'organiser cannot use the admin route')
      const r = await api<PhotoBody>(E, { cookie: admin, body: { cover_photo: P1, photo_credit: 'Affiche officielle, avec accord' } })
      assertEq([r.status, r.body.changed?.sort()], [200, ['cover_photo', 'photo_credit']], 'poster + credit')
      const after = await feat()
      assertEq([after?.id, after?.image, after?.credit], [ev.id, P1, 'Affiche officielle, avec accord'], '« À la une » shows it, with the credit')
      assertEq((await audits('event_photo_changed', ev.id)).length, 2, 'two audit rows')
    })

    await step('organiser (Mes événements) still changes the poster; credit reset', async () => {
      const r = await api(`/api/events/${ev.id}`, { method: 'PATCH', cookie: customerCookie(org), body: { cover_photo: P2 } })
      assertEq(r.status, 200, `organiser saved (${r.raw.slice(0, 80)})`)
      const { data } = await sb.from('events').select('cover_photo, photo_credit, blur_hash').eq('id', ev.id).single()
      assertEq([data?.cover_photo, data?.photo_credit, data?.blur_hash], [P2, null, null], 'new poster, old credit + blur gone')
      const { data: pub } = await getAnon().from('events').select('id, photo_credit').eq('id', ev.id).maybeSingle()
      assertEq(pub?.id, ev.id, 'public key reads events.photo_credit')
    })

    await step('event: remove, rejected locked', async () => {
      assertEq((await api<PhotoBody>(E, { cookie: admin, body: { cover_photo: null } })).status, 200, 'poster removed')
      const { data } = await sb.from('events').select('cover_photo').eq('id', ev.id).single()
      assertEq(data?.cover_photo, null, 'no poster (generated cover)')
      const rej = await makeEvent({ organizerId: org.id, label: 'photo_rejected', city: CITY, extra: { event_status: 'rejected' } })
      assertEq((await api(`/api/admin/events/${rej.id}/photo`, { cookie: admin, body: { cover_photo: P1 } })).status, 404, 'rejected → 404')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
    finish(SUITE)
  }
}

void main()
