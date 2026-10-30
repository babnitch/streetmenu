// I2 — restaurant links (Instagram, Facebook, TikTok, website): set by the
// owner/manager or the admin, checked (a link per network), public. The
// admin-only phone to verify + note live in restaurant_admin_notes: never on
// the public restaurant row, never readable by a customer or the owner.
// Every phone is +999.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, addTeamMember } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-restaurant-links-i2'

async function main(): Promise<void> {
  try {
    const owner = await makeCustomer({ suiteNo: 94, name: 'Links Owner' })
    const staff = await makeCustomer({ suiteNo: 94, name: 'Links Staff' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'links_i2' })
    await addTeamMember(rest.id, staff.id, 'staff')
    const oc = customerCookie(owner)

    await step('owner sets links; each must be the right network', async () => {
      const bad = await api<{ field?: string }>(`/api/restaurants/${rest.id}`, { method: 'PATCH', cookie: oc, body: { instagram_url: 'https://facebook.com/x' } })
      assertEq([bad.status, bad.body.field], [400, 'instagram_url'], 'Instagram field with a Facebook link → 400')
      assertEq((await api(`/api/restaurants/${rest.id}`, { method: 'PATCH', cookie: oc, body: { website_url: 'notaurl' } })).status, 400, 'not a URL → 400')
      const ok = await api(`/api/restaurants/${rest.id}`, { method: 'PATCH', cookie: oc, body: {
        instagram_url: 'https://www.instagram.com/test/', facebook_url: 'https://www.facebook.com/test', tiktok_url: '', website_url: 'https://example.cm',
      } })
      assertEq(ok.status, 200, `saved (${ok.raw.slice(0, 60)})`)
      const { data } = await sb.from('restaurants').select('instagram_url, facebook_url, tiktok_url, website_url').eq('id', rest.id).single()
      assertEq(data, { instagram_url: 'https://www.instagram.com/test/', facebook_url: 'https://www.facebook.com/test', tiktok_url: null, website_url: 'https://example.cm' }, 'stored, empty = cleared')
      assertEq((await api(`/api/restaurants/${rest.id}`, { method: 'PATCH', cookie: customerCookie(staff), body: { website_url: 'https://x.cm' } })).status, 403, 'staff → 403')
    })

    await step('admin: links + the admin-only phone to verify', async () => {
      const admin = await adminCookie()
      assertEq((await api(`/api/admin/restaurants/${rest.id}/details`, { method: 'PUT', cookie: oc, body: {} })).status, 401, 'owner can\'t use the admin route')
      const r = await api(`/api/admin/restaurants/${rest.id}/details`, { method: 'PUT', cookie: admin, body: {
        instagram_url: 'https://instagram.com/admin', website_url: 'https://example.cm', phone_to_verify: '+237 694 00 00 00', note: 'à vérifier',
      } })
      assertEq(r.status, 200, 'saved')
      const g = await api<Record<string, string | null>>(`/api/admin/restaurants/${rest.id}/details`, { cookie: admin })
      assertEq([g.body.phone_to_verify, g.body.note, g.body.instagram_url], ['+237 694 00 00 00', 'à vérifier', 'https://instagram.com/admin'], 'admin reads it back')
      const { data: pub } = await sb.from('restaurants').select('*').eq('id', rest.id).single()
      assert(!('phone_to_verify' in (pub as object)), 'not on the public restaurant row')
      assertEq((await api(`/api/admin/restaurants/${rest.id}/details`, { cookie: oc })).status, 401, 'owner can\'t read the admin note')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
