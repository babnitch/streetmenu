// V5 — a picture for every NEW restaurant and every NEW event.
//
// Web restaurant signup (/api/restaurants/submit), admin restaurant create
// (/api/admin/restaurants, which also needs the owner's phone) and event submit (/api/events/submit) refuse a
// creation without a picture: 400 with the shared FR/EN message. The WhatsApp
// signup's photo step no longer takes "passer"/"skip": the session waits on
// step 5 until a photo arrives, and no restaurant is written.
//
// Every phone is +999. Event organisers are not auto-approved and use a
// per-run city, so no subscriber fan-out is reachable. The bot is driven with
// text and a non-image attachment only — no Twilio media is ever downloaded.

import { sb, testName, testPhone } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeEvent, futureDateISO, testPictureUrl } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { RESTAURANT_PHOTO_REQUIRED_TEXT, EVENT_POSTER_REQUIRED_TEXT } from '@/lib/pictureRequired'

const SUITE = 'api-pictures-v5'

interface ErrBody { error?: string; field?: string }

const send = (phone: string, body: string, extra: Record<string, string> = {}) =>
  api('/api/whatsapp/incoming', { form: { From: `whatsapp:${phone}`, Body: body, ...extra } })

async function sessionFor(phone: string) {
  const { data } = await sb.from('signup_sessions').select('user_type, step').eq('phone', phone).maybeSingle()
  return data as { user_type: string; step: number } | null
}

async function main(): Promise<void> {
  try {
    await step('web restaurant signup: no photo → 400 with the message; with a photo → created', async () => {
      const owner = await makeCustomer({ suiteNo: 66, name: 'V5 Resto Owner' })
      const cookie = customerCookie(owner)
      const body = { name: testName('v5_resto'), city: 'Yaoundé', neighborhood: 'Bastos', cuisine_type: 'Grillades' }

      const none = await api<ErrBody>('/api/restaurants/submit', { cookie, body })
      assertEq(none.status, 400, 'no image_url → 400')
      assertEq(none.body.error, RESTAURANT_PHOTO_REQUIRED_TEXT, 'the FR/EN photo message')
      assertEq(none.body.field, 'image_url', 'names the field')
      const foreign = await api<ErrBody>('/api/restaurants/submit', { cookie, body: { ...body, image_url: 'https://example.com/x.jpg' } })
      assertEq(foreign.status, 400, 'a URL that is not one of our uploads → 400')
      const { data: nothing } = await sb.from('restaurants').select('id').eq('name', body.name)
      assertEq((nothing ?? []).length, 0, 'nothing written')

      const r = await api<{ restaurant?: { id: string } }>('/api/restaurants/submit', { cookie, body: { ...body, image_url: testPictureUrl() } })
      assertEq(r.status, 200, `with a photo → 200 (${r.raw.slice(0, 120)})`)
      track('restaurants', r.body.restaurant?.id)
      const { data: row } = await sb.from('restaurants').select('image_url').eq('id', r.body.restaurant?.id ?? '').single()
      assertEq((row as { image_url: string }).image_url, testPictureUrl(), 'photo stored in image_url')
    })

    await step('admin restaurant create: no photo → 400 with the message; with a photo → created', async () => {
      const admin = await adminCookie()
      const owner = await makeCustomer({ suiteNo: 66, name: 'V5 Admin Owner' })
      const body = { name: testName('v5_admin_resto'), city: 'Yaoundé', lat: 3.87, lng: 11.52, whatsapp: owner.phone }

      const none = await api<ErrBody>('/api/admin/restaurants', { cookie: admin, body })
      assertEq(none.status, 400, 'no logo_url → 400')
      assertEq(none.body.error, RESTAURANT_PHOTO_REQUIRED_TEXT, 'the FR/EN photo message')
      const blank = await api<ErrBody>('/api/admin/restaurants', { cookie: admin, body: { ...body, logo_url: '   ' } })
      assertEq(blank.status, 400, 'blank logo_url → 400')

      const r = await api<{ restaurant?: { id: string; logo_url: string } }>('/api/admin/restaurants', {
        cookie: admin, body: { ...body, logo_url: testPictureUrl(), owner_phone: owner.phone },
      })
      if (r.body.restaurant?.id) track('restaurants', r.body.restaurant.id)
      assertEq(r.status, 200, `with a photo and an owner → 200 (${r.raw.slice(0, 160)})`)
      assertEq(r.body.restaurant?.logo_url, testPictureUrl(), 'photo stored in logo_url')
    })

    await step('admin restaurant create: owner by phone — existing account, new account, one per number', async () => {
      const admin = await adminCookie()
      const pic = testPictureUrl()
      const base = { city: 'Yaoundé', lat: 3.87, lng: 11.52, logo_url: pic }
      type Created = { restaurant?: { id: string; customer_id: string; owner?: { id: string } } } & ErrBody
      const create = (b: Record<string, unknown>) => api<Created>('/api/admin/restaurants', { cookie: admin, body: { ...base, ...b } })

      // N3: no owner phone → managed by Tchop & Ndjoka (api-managed-n3a).
      const noOwner = await create({ name: testName('v5_admin_noowner') })
      assertEq(noOwner.status, 200, 'no owner phone → managed restaurant')
      if (noOwner.body.restaurant) track('restaurants', noOwner.body.restaurant.id)
      assertEq(noOwner.body.restaurant?.customer_id ?? null, null, 'no owner')

      // Existing account → reused, owner team row written.
      const existing = await makeCustomer({ suiteNo: 66, name: 'V5 Existing Owner' })
      const a = await create({ name: testName('v5_admin_existing'), owner_phone: existing.phone })
      if (a.body.restaurant?.id) track('restaurants', a.body.restaurant.id)
      assertEq(a.status, 200, `existing account → 200 (${a.raw.slice(0, 160)})`)
      assertEq(a.body.restaurant?.customer_id, existing.id, 'owned by that account')
      assertEq(a.body.restaurant?.owner?.id, existing.id, 'owner returned for the panel')
      const { data: team } = await sb.from('restaurant_team').select('id, role, status')
        .eq('restaurant_id', a.body.restaurant?.id ?? '').eq('customer_id', existing.id)
      for (const t of team ?? []) track('restaurant_team', t.id as string)
      assert((team ?? []).length === 1 && team![0].role === 'owner' && team![0].status === 'active', 'one active owner team row')

      // Same number again → refused, one restaurant per number.
      const again = await create({ name: testName('v5_admin_again'), owner_phone: existing.phone })
      if (again.body.restaurant?.id) track('restaurants', again.body.restaurant.id)
      assertEq(again.status, 409, 'second restaurant for the number → 409')

      // New number: name required, then an account is created.
      const fresh = testPhone(66, 9000 + Math.floor(Math.random() * 900))
      const noName = await create({ name: testName('v5_admin_fresh'), owner_phone: fresh })
      assertEq(noName.status, 400, 'new number without a name → 400')
      assertEq(noName.body.field, 'owner_name', 'field owner_name')
      const n = await create({ name: testName('v5_admin_fresh'), owner_phone: fresh, owner_name: 'V5 New Owner' })
      if (n.body.restaurant?.id) track('restaurants', n.body.restaurant.id)
      const { data: cust } = await sb.from('customers').select('id, name').eq('phone', fresh).maybeSingle()
      if (cust?.id) track('customers', cust.id as string)
      assertEq(n.status, 200, `new number → 200 (${n.raw.slice(0, 160)})`)
      assert(!!cust && cust.name === 'V5 New Owner', 'account created with the name')
      assertEq(n.body.restaurant?.customer_id, cust?.id, 'restaurant owned by the new account')
      const { data: team2 } = await sb.from('restaurant_team').select('id, role')
        .eq('restaurant_id', n.body.restaurant?.id ?? '').eq('customer_id', cust?.id ?? '')
      for (const t of team2 ?? []) track('restaurant_team', t.id as string)
      assertEq((team2 ?? []).length, 1, 'owner team row for the new account')
    })

    await step('event submit: no poster → 400 with the message; with a poster → created', async () => {
      const org = await makeCustomer({ suiteNo: 66, name: 'V5 Organiser', extra: { event_auto_approve: false } })
      const cookie = customerCookie(org)
      const base = { title: testName('v5_event'), date: futureDateISO(20), city: testName('city'), category: 'Autre', ticket_price: 0, organizer_name: 'Asso' }

      const none = await api<ErrBody>('/api/events/submit', { cookie, body: base })
      assertEq(none.status, 400, 'no cover_photo → 400')
      assertEq(none.body.error, EVENT_POSTER_REQUIRED_TEXT, 'the FR/EN poster message')
      assertEq(none.body.field, 'cover_photo', 'names the field')
      const blank = await api<ErrBody>('/api/events/submit', { cookie, body: { ...base, cover_photo: '  ' } })
      assertEq(blank.status, 400, 'blank cover_photo → 400')
      const { data: nothing } = await sb.from('events').select('id').eq('title', base.title)
      assertEq((nothing ?? []).length, 0, 'nothing written')

      const poster = testPictureUrl('event-images')
      const r = await api<{ event_id?: string }>('/api/events/submit', { cookie, body: { ...base, cover_photo: poster } })
      assertEq(r.status, 200, `with a poster → 200 (${r.raw.slice(0, 120)})`)
      track('events', r.body.event_id)
      const { data: ev } = await sb.from('events').select('cover_photo').eq('id', r.body.event_id ?? '').single()
      assertEq((ev as { cover_photo: string }).cover_photo, poster, 'poster stored in cover_photo')
    })

    await step('an existing event without a poster can still be edited', async () => {
      const org = await makeCustomer({ suiteNo: 66, name: 'V5 Legacy Organiser', extra: { event_auto_approve: false } })
      const ev = await makeEvent({ organizerId: org.id, label: 'v5_legacy', whatsapp: org.phone })
      const r = await api(`/api/events/${ev.id}`, {
        method: 'PATCH', cookie: customerCookie(org), body: { description: 'sans affiche' },
      })
      assertEq(r.status, 200, `edit without a poster → 200 (${r.raw.slice(0, 120)})`)
      const { data } = await sb.from('events').select('description, cover_photo').eq('id', ev.id).single()
      const row = data as { description: string | null; cover_photo: string | null }
      assertEq(row.description, 'sans affiche', 'the edit landed')
      assertEq(row.cover_photo, null, 'still no poster — the placeholder stays')
    })

    await step('WhatsApp signup: the photo step cannot be skipped', async () => {
      const c = await makeCustomer({ suiteNo: 66, name: 'V5 Bot Owner' })
      const name = testName('v5_bot')
      await send(c.phone, 'restaurant')
      await send(c.phone, name)
      await send(c.phone, '1')         // Yaoundé
      await send(c.phone, 'Bastos')
      await send(c.phone, '1')         // cuisine
      assertEq((await sessionFor(c.phone))?.step, 5, 'reached the photo step')

      await send(c.phone, 'passer')
      assertEq((await sessionFor(c.phone))?.step, 5, '"passer" → still on the photo step')
      await send(c.phone, 'skip')
      assertEq((await sessionFor(c.phone))?.step, 5, '"skip" → still on the photo step')
      await send(c.phone, '', { NumMedia: '1', MediaContentType0: 'audio/ogg', MediaUrl0: 'https://example.invalid/voice.ogg' })
      assertEq((await sessionFor(c.phone))?.step, 5, 'a non-image attachment → still on the photo step')
      const { data: none } = await sb.from('restaurants').select('id').eq('name', name)
      assertEq((none ?? []).length, 0, 'no restaurant without a photo')

      // Control from the same phone: the refusals above were the step, not a throttle.
      await send(c.phone, 'annuler')
      assertEq(await sessionFor(c.phone), null, '"annuler" still closes the flow')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
