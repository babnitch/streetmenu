// "Autre… / Other…" proposals (Admin → Données de référence → Propositions).
//   - restaurant sign-up: cuisine optional (none → empty); "Autre…" city is
//     saved as typed with no pin; "Autre…" cuisine → the closest value
//   - event submit: "Autre…" category → closest or Autre; a proposed city
//     keeps the event unpublished even for a trusted organiser
//   - place proposal and profile city record proposals too
//   - admin: list (who, which item), map (sets the value + centre), accept
//     (an existing value is reused, set on the item), reject; once only;
//     audited
// +999 phones; test values only; the proposed city "Zz…" never exists.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, customerCookie } from '../testkit/session'
import { makeCustomer, futureDateISO, testPictureUrl } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-ref-proposals'
const TOWN = `Zz${testName('town').replace(/[^a-z0-9]/gi, '').slice(-8)}`

async function proposalsFor(targetId: string) {
  const { data } = await sb.from('ref_proposals').select('id, kind, proposed, saved_as, status').eq('target_id', targetId)
  return (data ?? []) as Array<{ id: string; kind: string; proposed: string; saved_as: string | null; status: string }>
}

async function main(): Promise<void> {
  const targets: string[] = []
  try {
    const admin = await adminCookie()
    const owner = await makeCustomer({ suiteNo: 54, name: 'Prop Owner' })
    const owner2 = await makeCustomer({ suiteNo: 54, name: 'Prop Owner 2' })
    const org = await makeCustomer({ suiteNo: 54, name: 'Prop Organiser', extra: { organizer_modules: ['reservations', 'auto_approve'] } })
    let restId = '', rest2Id = '', evId = ''

    await step('restaurant sign-up: cuisine optional; "Autre…" city and cuisine', async () => {
      const none = await api<{ restaurant?: { id: string } }>('/api/restaurants/submit', { cookie: customerCookie(owner2), body: { name: testName('prop_r2'), city: 'Douala', neighborhood: 'Akwa', image_url: testPictureUrl('photos') } })
      assertEq(none.status, 200, `no cuisine is fine (${none.raw.slice(0, 80)})`)
      rest2Id = none.body.restaurant!.id; track('restaurants', rest2Id); targets.push(rest2Id)
      const { data: r2 } = await sb.from('restaurants').select('cuisine_type').eq('id', rest2Id).single()
      assertEq(r2?.cuisine_type, null, 'no default cuisine')

      const r = await api<{ restaurant?: { id: string } }>('/api/restaurants/submit', { cookie: customerCookie(owner), body: {
        name: testName('prop_r'), city: '', city_other: TOWN, neighborhood: 'Centre', cuisine_type: '', cuisine_other: 'Pizza au feu de bois', image_url: testPictureUrl('photos'),
      } })
      assertEq(r.status, 200, `created (${r.raw.slice(0, 80)})`)
      restId = r.body.restaurant!.id; track('restaurants', restId); targets.push(restId)
      const { data } = await sb.from('restaurants').select('city, cuisine_type, lat, lng, is_active').eq('id', restId).single()
      assertEq([data?.city, data?.cuisine_type, data?.lat, data?.lng, data?.is_active], [TOWN, 'Pizza', 0, 0, false], 'typed city, no pin, closest cuisine (Pizza), pending')
      const props = await proposalsFor(restId)
      assertEq(props.map(p => `${p.kind}:${p.proposed}:${p.saved_as}`).sort(), [`city:${TOWN}:${TOWN}`, 'cuisine:Pizza au feu de bois:Pizza'], 'two proposals recorded')
      const bad = await api<{ field?: string }>('/api/restaurants/submit', { cookie: customerCookie(owner2), body: { name: testName('prop_bad'), city: 'Abidjan', neighborhood: 'X', image_url: testPictureUrl('photos') } })
      assert(bad.status === 400 || bad.status === 409, `a hidden city is refused (HTTP ${bad.status})`)
    })

    await step('event: "Autre…" category; a proposed city keeps it unpublished', async () => {
      const r = await api<{ event?: { id: string }; id?: string }>('/api/events/submit', { cookie: customerCookie(org), body: {
        title: testName('prop_ev'), date: futureDateISO(10), city: '', city_other: TOWN, category: '', category_other: 'Slam poésie',
        venue: 'Test Hall', cover_photo: testPictureUrl('photos'), organizer_name: 'Org',
      } })
      assertEq(r.status, 200, `submitted (${r.raw.slice(0, 100)})`)
      const { data: ev } = await sb.from('events').select('id, city, category, is_active').eq('title', testName('prop_ev')).single()
      evId = ev!.id; track('events', evId); targets.push(evId)
      assertEq([ev?.city, ev?.category, ev?.is_active], [TOWN, 'Autre', false], 'typed city, category Autre, NOT published (trusted organiser)')
      assertEq((await proposalsFor(evId)).length, 2, 'city + category proposals')
    })

    await step('place proposal and profile city record proposals', async () => {
      const p = await api<{ id: string }>('/api/places', { cookie: customerCookie(owner2), body: { title_fr: testName('prop_place'), city: testName('city'), category: '', category_other: 'Cascade' } })
      assertEq(p.status, 200, `place proposed (${p.raw.slice(0, 80)})`)
      track('places', p.body.id); targets.push(p.body.id)
      const { data: pl } = await sb.from('places').select('category').eq('id', p.body.id).single()
      assertEq(pl?.category, 'autre', 'saved as Autre')
      const prof = await api('/api/auth/update-profile', { method: 'POST', cookie: customerCookie(owner2), body: { city: '', city_other: TOWN } })
      assertEq(prof.status, 200, 'profile city proposed')
      targets.push(owner2.id)
      assertEq((await proposalsFor(owner2.id)).map(x => x.kind), ['city'], 'profile proposal recorded')
    })

    await step('admin: list, map, accept (existing value), reject — once only, audited', async () => {
      const list = await api<{ proposals: Array<{ id: string; target_id: string; kind: string; target: string | null; by: { phone: string | null } | null }> }>('/api/admin/ref/proposals', { cookie: admin })
      const mine = list.body.proposals.find(p => p.target_id === restId && p.kind === 'city')
      assertEq([mine?.target, mine?.by?.phone], [testName('prop_r'), owner.phone], 'who and which restaurant')
      const cityProp = (await proposalsFor(restId)).find(p => p.kind === 'city')!
      const cuisineProp = (await proposalsFor(restId)).find(p => p.kind === 'cuisine')!
      const map = await api(`/api/admin/ref/proposals/${cityProp.id}`, { cookie: admin, body: { action: 'map', code: 'Douala' } })
      assertEq(map.status, 200, 'mapped')
      const { data: r } = await sb.from('restaurants').select('city, lat, lng').eq('id', restId).single()
      assertEq([r?.city, r?.lat, r?.lng], ['Douala', 4.0511, 9.7679], 'city set, centre pin added')
      assertEq((await api(`/api/admin/ref/proposals/${cityProp.id}`, { cookie: admin, body: { action: 'reject' } })).status, 409, 'once only')
      const acc = await api<{ code: string }>(`/api/admin/ref/proposals/${cuisineProp.id}`, { cookie: admin, body: { action: 'accept', label_fr: 'Grillades', label_en: 'Grilled' } })
      assertEq([acc.status, acc.body.code], [200, 'grillades'], 'accept → the existing value is reused')
      const { data: r3 } = await sb.from('restaurants').select('cuisine_type').eq('id', restId).single()
      assertEq(r3?.cuisine_type, 'Grillades', 'set on the restaurant')
      const evCat = (await proposalsFor(evId)).find(p => p.kind === 'event_category')!
      assertEq((await api(`/api/admin/ref/proposals/${evCat.id}`, { cookie: admin, body: { action: 'reject' } })).status, 200, 'rejected')
      const { data: ev } = await sb.from('events').select('category').eq('id', evId).single()
      assertEq(ev?.category, 'Autre', 'rejected → the item keeps what it was saved with')
      const { data: audit } = await sb.from('audit_log').select('action').in('target_id', [cityProp.id, cuisineProp.id, evCat.id])
      const acts = (audit ?? []).map(a => (a as { action: string }).action).sort()
      assertEq(acts, ['ref_proposal_accepted', 'ref_proposal_mapped', 'ref_proposal_rejected'], 'audited')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    if (targets.length) {
      const { data: props } = await sb.from('ref_proposals').select('id').in('target_id', targets)
      const ids = (props ?? []).map(p => p.id as string)
      if (ids.length) { await sb.from('audit_log').delete().in('target_id', ids); await sb.from('ref_proposals').delete().in('id', ids) }
    }
    await teardown()
  }
  finish(SUITE)
}

void main()
