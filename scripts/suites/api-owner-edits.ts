// Owners edit everything customers see about their restaurant; organisers
// everything about their event — except what stays protected.
//   Restaurant (owner only — implicit or team owner; not a manager, not staff):
//     - details: name, description, cuisine, city, area, address, map pin,
//       phone, WhatsApp — live at once (no new approval), audited old → new
//     - name / address / pin / city / area / phones → « Modifié par le
//       propriétaire » for the admins (list + « Vu », audited); description /
//       cuisine alone → no notice
//     - photos: cover + LOGO replaced / removed, audited; the photo credit
//       stays admin-only
//     - protected: status, is_active, managed_by_platform, modules, payout
//       number — sent fields are ignored
//     - checks: name, city we serve, pin in the city, WhatsApp valid + one
//       restaurant per number; a deleted restaurant is locked
//   Event (organiser): city, « À partir de », organiser name, public WhatsApp,
//     new poster with its blur placeholder; paid tickets need the module
// Per-run test city; an inactive restaurant / event for the moves to a real city.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish, warn } from '../testkit/assert'
import { api, adminCookie, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeEvent, addTeamMember, futureDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { checkRestaurantDetails, type DetailRow } from '@/lib/restaurantDetails'

const SUITE = 'api-owner-edits'
const CITY = testName('city')
const LOGO = 'https://example.com/t/owner-logo.png'

interface Body { ok?: boolean; error?: string; field?: string; changed?: string[]; restaurant?: Record<string, unknown>; reason?: string }
interface Notice { id: string; restaurant_id: string; changes: Record<string, { old: unknown; new: unknown }>; restaurants: { name: string } | null }

async function trackNotices(restaurantId: string): Promise<void> {
  const { data } = await sb.from('restaurant_change_notices').select('id').eq('restaurant_id', restaurantId)
  for (const n of data ?? []) track('restaurant_change_notices', n.id)
}

async function main(): Promise<void> {
  try {
    await step('the checks (no database)', () => {
      const cur = { name: 'Chez A', description: null, cuisine_type: null, city: 'Douala', neighborhood: 'Akwa', address: null, lat: 4.05, lng: 9.77, phone: null, whatsapp: '+237600000001' } as DetailRow
      const ok = checkRestaurantDetails({ name: '  Chez  B ', description: 'Bon', address: 'Rue 1' }, cur)
      assert(ok.ok && ok.patch.name === 'Chez B' && ok.patch.address === 'Rue 1', 'tidied + changed only')
      const same = checkRestaurantDetails({ name: 'Chez A' }, cur)
      assert(same.ok && Object.keys(same.patch).length === 0, 'unchanged → nothing')
      assertEq(checkRestaurantDetails({ name: 'A' }, cur).ok, false, 'name too short')
      assertEq(checkRestaurantDetails({ whatsapp: '12' }, cur).ok, false, 'bad WhatsApp')
      assertEq(checkRestaurantDetails({ city: 'Atlantis' }, cur).ok, false, 'unknown city')
      assertEq(checkRestaurantDetails({ lat: 48.85, lng: 2.35 }, cur).ok, false, 'pin outside the city')
      const moved = checkRestaurantDetails({ city: 'Yaoundé' }, cur)
      assert(moved.ok && moved.patch.city === 'Yaoundé' && Math.abs(Number(moved.patch.lat) - 3.848) < 0.01, 'new city, old pin elsewhere → city centre')
      const noPhone = checkRestaurantDetails({ phone: '' }, { ...cur, phone: '+237600000002' })
      assert(noPhone.ok && noPhone.patch.phone === null, 'phone can be cleared')
    })

    const { error: missing } = await sb.from('restaurant_change_notices').select('id').limit(1)
    if (missing) { warn('restaurant_change_notices missing', 'run supabase-restaurant-change-notices.sql, then re-run api-owner-edits'); return }

    const admin = await adminCookie()
    const owner = await makeCustomer({ suiteNo: 64, name: 'Edit Owner' })
    const manager = await makeCustomer({ suiteNo: 64, name: 'Edit Manager' })
    const stranger = await makeCustomer({ suiteNo: 64, name: 'Edit Stranger' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'edit_rest', city: CITY })
    await addTeamMember(rest.id, manager.id, 'manager')
    const D = `/api/restaurants/${rest.id}/details`
    const IMG = `/api/restaurants/${rest.id}/image`

    await step('details: who may', async () => {
      assertEq((await api(D, { body: { name: 'X Y' } })).status, 401, 'no session')
      assertEq((await api(D, { cookie: admin, body: { name: 'X Y' } })).status, 401, 'admin session is not the owner route')
      assertEq((await api(D, { cookie: customerCookie(manager), body: { name: 'X Y' } })).status, 403, 'manager → 403')
      assertEq((await api(D, { cookie: customerCookie(stranger), body: { name: 'X Y' } })).status, 403, 'stranger → 403')
    })

    await step('details: live at once, audited, admins told', async () => {
      const newName = testName('edit_rest_renamed')
      const r = await api<Body>(D, { cookie: customerCookie(owner), body: {
        name: newName, description: 'Poulet DG et ndolé', address: 'Rue 1.234, face pharmacie', neighborhood: 'Bonapriso', phone: '+237655000111',
        status: 'pending', is_active: false, managed_by_platform: true, modules: [], payout_phone: '+237699999999',
      } })
      assertEq(r.status, 200, `saved (${r.raw.slice(0, 100)})`)
      assertEq(r.body.changed?.sort(), ['address', 'description', 'name', 'neighborhood', 'phone'], 'only the details changed')
      const { data } = await sb.from('restaurants').select('name, description, address, neighborhood, phone, status, is_active, managed_by_platform, modules, payout_phone').eq('id', rest.id).single()
      assertEq([data?.name, data?.address, data?.status, data?.is_active, data?.managed_by_platform, (data?.modules as string[]).length > 0, data?.payout_phone ?? null],
        [newName, 'Rue 1.234, face pharmacie', 'active', true, false, true, null], 'saved; status / active / managed / modules / payout untouched')
      const { data: au } = await sb.from('audit_log').select('metadata, performed_by_type').eq('action', 'restaurant_details_changed').eq('target_id', rest.id).single()
      const ch = (au?.metadata as { changes: Record<string, { old: unknown; new: unknown }> }).changes
      assertEq([au?.performed_by_type, ch.name.old, ch.name.new], ['owner', rest.name, newName], 'audit: old → new')
      await trackNotices(rest.id)
      const { data: notices } = await sb.from('restaurant_change_notices').select('changes').eq('restaurant_id', rest.id)
      assertEq(Object.keys((notices?.[0]?.changes ?? {}) as object).sort(), ['address', 'name', 'neighborhood', 'phone'], 'notice: name, address, area, phone (not description)')
      const d2 = await api<Body>(D, { cookie: customerCookie(owner), body: { description: 'Encore meilleur' } })
      assertEq(d2.status, 200, 'description alone')
      await trackNotices(rest.id)
      const { count } = await sb.from('restaurant_change_notices').select('id', { count: 'exact', head: true }).eq('restaurant_id', rest.id)
      assertEq(count, 1, 'no notice for description alone')
    })

    await step('details: checks', async () => {
      const own = customerCookie(owner)
      assertEq((await api<Body>(D, { cookie: own, body: { name: 'A' } })).body.field, 'name', 'name too short')
      assertEq((await api<Body>(D, { cookie: own, body: { city: 'Atlantis' } })).body.field, 'city', 'city we serve only')
      assertEq((await api<Body>(D, { cookie: own, body: { whatsapp: 'abc' } })).body.field, 'whatsapp', 'bad WhatsApp')
      const other = await makeRestaurant({ label: 'edit_other', city: CITY })
      const taken = await api<Body>(D, { cookie: own, body: { whatsapp: other.whatsapp } })
      assertEq([taken.status, taken.body.field], [409, 'whatsapp'], 'a number another restaurant uses → 409')
    })

    await step('admins: « Modifié par le propriétaire » + « Vu »', async () => {
      assertEq((await api('/api/admin/restaurant-notices', { cookie: customerCookie(owner) })).status, 401, 'customer → 401')
      const list = await api<{ notices: Notice[] }>('/api/admin/restaurant-notices', { cookie: admin })
      const mine = (list.body.notices ?? []).filter(n => n.restaurant_id === rest.id)
      assertEq(mine.length, 1, 'listed')
      assert(mine[0].restaurants?.name?.includes('edit_rest_renamed') === true && String(mine[0].changes.address.new).startsWith('Rue 1.234'), 'with the name and the change')
      assertEq((await api(`/api/admin/restaurant-notices/${mine[0].id}`, { cookie: admin, body: { action: 'seen' } })).status, 200, 'seen')
      const again = await api<{ notices: Notice[] }>('/api/admin/restaurant-notices', { cookie: admin })
      assert(!(again.body.notices ?? []).some(n => n.id === mine[0].id), 'gone from the list')
      const { data: kept } = await sb.from('restaurant_change_notices').select('seen_at, deleted_at').eq('id', mine[0].id).single()
      assert(!!kept?.seen_at && !kept.deleted_at, 'kept, marked seen (never deleted)')
      assertEq((await api(`/api/admin/restaurant-notices/${mine[0].id}`, { cookie: admin, body: { action: 'seen' } })).status, 404, 'seen twice → 404')
      const { count } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('action', 'restaurant_change_notice_seen').eq('target_id', rest.id)
      assertEq(count, 1, 'audited')
    })

    await step('move to a served city + map pin (inactive restaurant)', async () => {
      const o2 = await makeCustomer({ suiteNo: 64, name: 'Edit Owner 2' })
      const hidden = await makeRestaurant({ ownerId: o2.id, label: 'edit_move', city: CITY, isActive: false, status: 'pending' })
      const D2 = `/api/restaurants/${hidden.id}/details`
      const far = await api<Body>(D2, { cookie: customerCookie(o2), body: { city: 'Douala', lat: 3.85, lng: 11.5 } })
      assertEq([far.status, far.body.field], [400, 'lat'], 'a Yaoundé pin for Douala → refused')
      const r = await api<Body>(D2, { cookie: customerCookie(o2), body: { city: 'Douala', lat: 4.0525, lng: 9.7001 } })
      assertEq(r.status, 200, 'moved')
      const { data } = await sb.from('restaurants').select('city, lat, lng, status').eq('id', hidden.id).single()
      assertEq([data?.city, data?.lat, data?.lng, data?.status], ['Douala', 4.0525, 9.7001, 'pending'], 'city + pin saved, status unchanged')
      await trackNotices(hidden.id)
    })

    await step('photos: logo + cover, owner only, credit stays admin-only', async () => {
      assertEq((await api(IMG, { cookie: customerCookie(manager), body: { logo_url: LOGO } })).status, 403, 'manager → 403')
      await sb.from('restaurants').update({ photo_credit: 'Crédit admin' }).eq('id', rest.id)
      const r = await api<Body>(IMG, { cookie: customerCookie(owner), body: { logo_url: LOGO, photo_credit: 'Moi' } })
      assertEq([r.status, r.body.changed], [200, ['logo_url']], 'logo set')
      const { data } = await sb.from('restaurants').select('logo_url, photo_credit').eq('id', rest.id).single()
      assertEq([data?.logo_url, data?.photo_credit], [LOGO, null], 'logo saved; credit not settable by the owner (and reset for the new photo)')
      assertEq((await api<Body>(IMG, { cookie: customerCookie(owner), body: { logo_url: null } })).status, 200, 'logo removed')
      const { data: d2 } = await sb.from('restaurants').select('logo_url').eq('id', rest.id).single()
      assertEq(d2?.logo_url, null, 'no logo')
      const { data: au } = await sb.from('audit_log').select('metadata, performed_by_type').eq('action', 'restaurant_photo_changed').eq('target_id', rest.id).order('created_at')
      assertEq((au ?? []).map(a => `${a.performed_by_type}:${(a.metadata as Record<string, unknown>).field}:${(a.metadata as Record<string, unknown>).new ?? '-'}`), [`owner:logo_url:${LOGO}`, 'owner:logo_url:-'], 'audited')
    })

    await step('implicit owner (no team row) can edit too', async () => {
      const o3 = await makeCustomer({ suiteNo: 64, name: 'Edit Owner 3' })
      const r3 = await makeRestaurant({ ownerId: o3.id, label: 'edit_implicit', city: CITY })
      await sb.from('restaurant_team').delete().eq('restaurant_id', r3.id).eq('customer_id', o3.id)
      assertEq((await api(`/api/restaurants/${r3.id}/image`, { cookie: customerCookie(o3), body: { image_url: LOGO } })).status, 200, 'photo')
      assertEq((await api(`/api/restaurants/${r3.id}/details`, { cookie: customerCookie(o3), body: { description: 'Implicite' } })).status, 200, 'details')
    })

    await step('WhatsApp « photo »: owner only, same rule as the website', async () => {
      const send = (phone: string, body: string, extra: Record<string, string> = {}) =>
        api('/api/whatsapp/incoming', { form: { From: `whatsapp:${phone}`, Body: body, ...extra } })
      const session = async (phone: string) => (await sb.from('signup_sessions').select('user_type, data').eq('phone', phone).maybeSingle()).data as { user_type: string; data: Record<string, unknown> } | null
      const bo = await makeCustomer({ suiteNo: 64, name: 'Bot Owner' })
      const bm = await makeCustomer({ suiteNo: 64, name: 'Bot Manager' })
      const holder = await makeCustomer({ suiteNo: 64, name: 'Bot Number Holder' })
      const br = await makeRestaurant({ ownerId: bo.id, label: 'bot_photo', city: CITY, whatsapp: bo.phone })
      await addTeamMember(br.id, bm.id, 'manager')
      // A restaurant whose WhatsApp number belongs to someone who isn't its owner.
      const other = await makeRestaurant({ label: 'bot_photo_other', city: CITY, whatsapp: holder.phone })
      try {
        await send(bo.phone, 'photo')
        const s1 = await session(bo.phone)
        assertEq([s1?.user_type, s1?.data?.restaurant_id], ['photo_update', br.id], 'owner → waiting for the photo, for this restaurant')
        await send(bm.phone, 'photo')
        assertEq(await session(bm.phone), null, 'manager → politely refused')
        await send(holder.phone, 'photo')
        assertEq(await session(holder.phone), null, 'number holder who is not the owner → refused')
        // A photo arriving in a session that isn't the owner's: refused, nothing saved.
        await sb.from('signup_sessions').upsert({ phone: holder.phone, user_type: 'photo_update', step: 1, data: { restaurant_id: other.id, customer_id: holder.id }, expires_at: new Date(Date.now() + 300_000).toISOString() })
        await send(holder.phone, '', { NumMedia: '1', MediaUrl0: 'https://example.com/t/x.jpg', MediaContentType0: 'image/jpeg' })
        assertEq(await session(holder.phone), null, 'session closed')
        const { data } = await sb.from('restaurants').select('image_url').eq('id', other.id).single()
        assertEq(data?.image_url ?? null, null, 'photo unchanged')
      } finally {
        await sb.from('signup_sessions').delete().in('phone', [bo.phone, bm.phone, holder.phone])
      }
    })

    await step('deleted restaurant: locked', async () => {
      const o4 = await makeCustomer({ suiteNo: 64, name: 'Edit Owner 4' })
      const gone = await makeRestaurant({ ownerId: o4.id, label: 'edit_gone', city: CITY, extra: { deleted_at: new Date().toISOString() } })
      assertEq((await api(`/api/restaurants/${gone.id}/details`, { cookie: customerCookie(o4), body: { name: 'Revenu' } })).status, 404, 'details → 404')
      assertEq((await api(`/api/restaurants/${gone.id}/image`, { cookie: customerCookie(o4), body: { image_url: LOGO } })).status, 404, 'photo → 404')
    })

    await step('event: organiser edits city, « À partir de », organiser name, WhatsApp, poster blur', async () => {
      const org = await makeCustomer({ suiteNo: 64, name: 'Edit Organiser' })
      const ev = await makeEvent({ organizerId: org.id, label: 'edit_event', city: CITY, isActive: false, date: futureDateISO(9) })
      const P = (body: Record<string, unknown>) => api<Body>(`/api/events/${ev.id}`, { method: 'PATCH', cookie: customerCookie(org), body })
      assertEq((await P({ city: 'Atlantis' })).body.field, 'city', 'unknown city → 400')
      assertEq((await P({ organizer_name: 'A' })).body.field, 'organizer_name', 'organiser name too short')
      assertEq((await P({ whatsapp: '12' })).body.field, 'whatsapp', 'bad WhatsApp')
      const r = await P({ city: 'Douala', price_is_from: true, organizer_name: 'Kmer Prod', whatsapp: '6 77 12 34 56', cover_photo: LOGO, blur_hash: 'LKO2?U%2Tw=w' })
      assertEq(r.status, 200, `saved (${r.raw.slice(0, 100)})`)
      const { data } = await sb.from('events').select('city, price_is_from, organizer_name, whatsapp, cover_photo, blur_hash, is_active, event_status').eq('id', ev.id).single()
      assertEq(data, { city: 'Douala', price_is_from: true, organizer_name: 'Kmer Prod', whatsapp: '+237677123456', cover_photo: LOGO, blur_hash: 'LKO2?U%2Tw=w', is_active: false, event_status: 'upcoming' },
        'saved; approval untouched')
    })

    await step('event: paid tickets need the module', async () => {
      const basic = await makeCustomer({ suiteNo: 64, name: 'Edit Basic Org', extra: { organizer_modules: ['reservations'] } })
      const ev = await makeEvent({ organizerId: basic.id, label: 'edit_paid', city: CITY, isActive: false, date: futureDateISO(9), ticketPrice: 5000 })
      const P = (body: Record<string, unknown>) => api<Body>(`/api/events/${ev.id}`, { method: 'PATCH', cookie: customerCookie(basic), body })
      const no = await P({ payment_mode: 'payment_only' })
      assertEq([no.status, no.body.reason], [403, 'module_off'], 'without « Billets payants » → refused')
      assertEq((await P({ payment_mode: 'reservation_only', title: testName('edit_paid_2') })).status, 200, 'unchanged free mode → fine')
      assertEq((await api(`/api/events/${ev.id}`, { method: 'PATCH', cookie: admin, body: { payment_mode: 'payment_only' } })).status, 200, 'an admin can')
      const paid = await makeCustomer({ suiteNo: 64, name: 'Edit Paid Org' })
      const ev2 = await makeEvent({ organizerId: paid.id, label: 'edit_paid_ok', city: CITY, isActive: false, date: futureDateISO(9), ticketPrice: 5000 })
      assertEq((await api(`/api/events/${ev2.id}`, { method: 'PATCH', cookie: customerCookie(paid), body: { payment_mode: 'payment_only' } })).status, 200, 'with the module → fine')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
    finish(SUITE)
  }
}

void main()
