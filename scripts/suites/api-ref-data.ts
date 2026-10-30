// Reference data (Admin → Données de référence).
//   - /api/ref gives visible AND hidden values (hidden ones only to label
//     items that already use them); pickers use visible ones
//   - a HIDDEN value still labels the items that use it (event card / page,
//     admin), is not offered (forms refuse it), and is never deleted
//   - hidden cities: not offered in forms, their data still served
//   - admin API: admin + super admin; "used by N"; reorder; audit
//   - cuisine rules: optional text, no default; chips = the 7, in order
// Test values use a run-unique code, created hidden; removed at the end.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, staffCookie, customerCookie } from '../testkit/session'
import { makeCustomer, makeEvent } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'
import { setRefValues, refLabel, refList, REF_BACKUP, type RefValue } from '@/lib/refData'
import { eventCategories, categoryLabel } from '@/lib/categoryLabels'
import { cuisineText, homeCuisineChips, matchesCuisineCategory } from '@/lib/cuisineCategories'
import { visibleCities, allCities } from '@/lib/cities'

const SUITE = 'api-ref-data'

async function main(): Promise<void> {
  const label = testName('cat').slice(0, 50)
  let refId = ''
  try {
    const admin = await adminCookie()

    await step('backup = the seed: 2 visible cities, 3 hidden; Enfants label has no emoji', () => {
      setRefValues(REF_BACKUP as RefValue[])
      assertEq(visibleCities(), ['Yaoundé', 'Douala'], 'offered cities')
      assertEq(allCities(), ['Yaoundé', 'Douala', 'Abidjan', 'Dakar', 'Lomé'], 'known cities')
      assertEq([categoryLabel('Enfants', 'fr'), categoryLabel('Enfants', 'en')], ['Enfants', 'Kids'], 'Enfants / Kids')
      assertEq(refList('cuisine').length, 11, '11 cuisines')
    })

    await step('cuisine rules', () => {
      assertEq(homeCuisineChips().map(c => c.id), ['grillades', 'poisson', 'fastfood', 'pizza', 'healthy', 'bar', 'desserts'], 'the 7 chips, in order (no Camerounaise)')
      assertEq(cuisineText({ cuisine_type: '' }, 'fr'), null, 'empty → none (no default)')
      assertEq(cuisineText({ cuisine_type: null }, 'en'), null, 'null → none')
      assertEq(cuisineText({ cuisine_type: 'Grillades' }, 'en'), 'Grilled', 'a reference value → its label in the viewer\'s language')
      assertEq(cuisineText({ cuisine_type: 'Restaurant-lounge' }, 'en'), 'Restaurant-lounge', 'free text stays as typed')
      assert(matchesCuisineCategory({ cuisine_type: 'Sénégalaise' }, 'senegalaise'), 'Sénégalaise is its own value')
      assert(!matchesCuisineCategory({ cuisine_type: 'Sénégalaise' }, 'camerounaise'), '…no longer under Camerounaise')
    })

    await step('/api/ref: visible and hidden values, flagged', async () => {
      const r = await api<{ values: Array<{ kind: string; code: string; visible: boolean }> }>('/api/ref')
      assertEq(r.status, 200, '200')
      const abj = r.body.values.find(v => v.kind === 'city' && v.code === 'Abidjan')
      assertEq(abj?.visible, false, 'Abidjan is there, hidden')
    })

    await step('admin API: access, add (hidden), used by N, no delete', async () => {
      const mod = staffCookie({ id: '00000000-0000-0000-0000-000000000001', email: 'm@test.invalid', name: 'Mod', role: 'moderator' })
      assertEq((await api('/api/admin/ref', { cookie: mod })).status, 401, 'moderator → 401')
      const bad = await api<{ field?: string }>('/api/admin/ref', { cookie: admin, body: { kind: 'event_category', label_fr: '', label_en: 'x' } })
      assertEq([bad.status, bad.body.field], [400, 'label_fr'], 'FR label required')
      const r = await api<{ value: { id: string; code: string; visible: boolean } }>('/api/admin/ref', { cookie: admin, body: { kind: 'event_category', label_fr: label, label_en: label + ' EN', icon: '🧪', visible: false } })
      assertEq(r.status, 200, `created (${r.raw.slice(0, 80)})`)
      refId = r.body.value.id
      assertEq([r.body.value.code, r.body.value.visible], [label, false], 'code = FR label, created hidden')
      assertEq((await api('/api/admin/ref', { cookie: admin, body: { kind: 'event_category', label_fr: label, label_en: 'dup' } })).status, 409, 'duplicate → 409')
      assertEq((await api(`/api/admin/ref/${refId}`, { method: 'DELETE', cookie: admin })).status, 405, 'no delete')
    })

    await step('a HIDDEN value still labels the items that use it', async () => {
      const ev = await makeEvent({ label: 'ref_hidden', category: label })
      const all = await api<{ values: RefValue[] }>('/api/ref')
      setRefValues(all.body.values)
      assertEq(refLabel('event_category', label, 'en'), label + ' EN', 'label known to the browser (hidden)')
      assert(!eventCategories().includes(label), 'not offered in pickers')
      const list = await api<{ values: Array<{ id: string; usage: { total: number } }> }>('/api/admin/ref', { cookie: admin })
      assertEq(list.body.values.find(v => v.id === refId)?.usage.total, 1, 'used by 1 (the event)')
      const create = await api('/api/admin/events', { cookie: admin, body: { title: testName('ref_ev'), category: label, city: testName('city'), date: '2030-01-01' } })
      assertEq(create.status, 400, 'a new event cannot pick the hidden category')
      const { data } = await sb.from('events').select('category').eq('id', ev.id).single()
      assertEq(data?.category, label, 'the existing event keeps it')
    })

    await step('hidden city: not offered, its data still served', async () => {
      const c = await makeCustomer({ suiteNo: 53, name: 'Ref City' })
      const r = await api('/api/auth/update-profile', { method: 'POST', cookie: customerCookie(c), body: { city: 'Abidjan' } })
      assert(r.status === 400 || r.status === 405, `profile cannot pick a hidden city (HTTP ${r.status})`)
      assertEq((await api(`/api/popular?city=${encodeURIComponent('Abidjan')}`)).status, 200, 'its public lists still answer')
    })

    await step('admin: show / move, audited', async () => {
      assertEq((await api(`/api/admin/ref/${refId}`, { method: 'PATCH', cookie: admin, body: { label_en: label + ' EN2' } })).status, 200, 'label edited')
      assertEq((await api(`/api/admin/ref/${refId}`, { method: 'PATCH', cookie: admin, body: { move: 'up' } })).status, 200, 'moved')
      await api(`/api/admin/ref/${refId}`, { method: 'PATCH', cookie: admin, body: { move: 'down' } })   // and back: the real order stays
      const { data: audit } = await sb.from('audit_log').select('action').eq('target_id', refId)
      const actions = (audit ?? []).map(a => (a as { action: string }).action)
      assert(['ref_value_created', 'ref_value_updated', 'ref_value_moved'].every(a => actions.includes(a)), `audited (${actions.join(',')})`)
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
    if (refId) {
      await sb.from('audit_log').delete().eq('target_id', refId)
      await sb.from('ref_values').delete().eq('id', refId)
    }
  }
  finish(SUITE)
}

void main()
