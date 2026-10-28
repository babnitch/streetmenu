// M4 — organiser modules, on the server.
//
// Réservations (/reserve, and the page's booking flags), Billets payants
// (/pay), Contrôle des billets (attend), Codes promo (create; event codes
// stop working when off), À la une (buying a placement), Auto-approbation
// (submit publishes at once only with the module). Refusals are 403
// reason module_off.
//
// Every phone is +999; events use per-run cities (no subscriber fan-out).

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeEvent, makeVoucher, futureDateISO, testPictureUrl } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { effectiveEventMode } from '../../lib/modules'
import { validateVoucher } from '../../lib/vouchers'
import { countMatchingSubscribers } from '../../lib/subscriptions'

const SUITE = 'api-modules-m4'

interface Body { ok?: boolean; reason?: string; error?: string; reservation_id?: string; reservation_ids?: string[] }

async function main(): Promise<void> {
  try {
    await step('mode: no Billets payants → pay at the door', async () => {
      assertEq(effectiveEventMode('payment_only', { reservations: true, paid_tickets: false }), 'reservation_only', 'downgraded')
      assertEq(effectiveEventMode('both', { reservations: true, paid_tickets: true }), 'both', 'kept')
      assertEq(effectiveEventMode('both', null), 'both', 'unknown → server decides')
    })

    const org = await makeCustomer({ suiteNo: 74, name: 'M4 Organiser', extra: { organizer_modules: [], event_auto_approve: false } })
    const buyer = await makeCustomer({ suiteNo: 74, name: 'M4 Buyer' })
    const bc = customerCookie(buyer)
    const ev = await makeEvent({ organizerId: org.id, label: 'm4_event', isActive: true, ticketPrice: 2000,
      extra: { payment_mode: 'both', payment_enabled: true } })
    const setMods = (m: string[]) => sb.from('customers').update({ organizer_modules: m }).eq('id', org.id)
    const trackRes = (b: Body) => { for (const id of b.reservation_ids ?? (b.reservation_id ? [b.reservation_id] : [])) track('event_reservations', id) }

    await step('basic page: no booking; the page is told so', async () => {
      const r = await api<Body>(`/api/events/${ev.id}/reserve`, { cookie: bc, body: { quantity: 1 } })
      trackRes(r.body)
      assertEq(r.status, 403, `reserve → 403 (${r.raw.slice(0, 100)})`)
      assertEq(r.body.reason, 'module_off', 'reason module_off')
      const a = await api<{ booking?: { reservations: boolean; paid_tickets: boolean } }>(`/api/events/${ev.id}/availability`)
      assertEq(a.body.booking, { reservations: false, paid_tickets: false }, 'availability says no booking')
    })

    await step('Réservations only: booking works, paying online doesn\'t', async () => {
      await setMods(['reservations'])
      const r = await api<Body>(`/api/events/${ev.id}/reserve`, { cookie: bc, body: { quantity: 1 } })
      trackRes(r.body)
      assertEq(r.status, 200, `reserve → 200 (${r.raw.slice(0, 120)})`)
      const p = await api<Body>(`/api/events/${ev.id}/pay`, { cookie: bc, body: { quantity: 1, phoneNumber: '+237670000000' } })
      trackRes(p.body)
      assertEq(p.status, 403, `pay → 403 (${p.raw.slice(0, 100)})`)
      assertEq(p.body.reason, 'module_off', 'reason module_off')
    })

    await step('Contrôle des billets: door check-in needs the module', async () => {
      const { data } = await sb.from('event_reservations').insert({
        event_id: ev.id, customer_id: buyer.id, customer_name: buyer.name, customer_phone: buyer.phone,
        quantity: 1, reservation_status: 'confirmed', reservation_code: 'M4C1',
      } as never).select('id').single()
      const resId = (data as { id: string }).id
      track('event_reservations', resId)
      const off = await api<Body>(`/api/events/${ev.id}/reservations/${resId}/attend`, { method: 'POST', cookie: customerCookie(org) })
      assertEq(off.status, 403, 'attend → 403')
      await setMods(['reservations', 'ticket_control'])
      const on = await api<Body>(`/api/events/${ev.id}/reservations/${resId}/attend`, { method: 'POST', cookie: customerCookie(org) })
      assertEq(on.status, 200, `with the module → 200 (${on.raw.slice(0, 100)})`)
    })

    await step('Codes promo: creating needs it; event codes stop when off', async () => {
      const c = await api<Body>(`/api/events/${ev.id}/vouchers`, { cookie: customerCookie(org), body: { code: 'M4CODE', discount_type: 'percent', discount_value: 10 } })
      assertEq(c.status, 403, 'create → 403')
      const v = await makeVoucher({ label: 'm4code', discountValue: 10, extra: { event_id: ev.id, per_customer_max: 0 } })
      const off = await validateVoucher(v.code, { customerId: null, eventId: ev.id, orderTotal: 2000, city: null })
      assert(!off.ok && off.reason === 'inactive', 'event code refused without the module')
      await setMods(['reservations', 'promo_codes'])
      const on = await validateVoucher(v.code, { customerId: null, eventId: ev.id, orderTotal: 2000, city: null })
      assert(on.ok, 'works with it')
    })

    await step('À la une: buying a placement needs it', async () => {
      const today = new Date().toISOString().slice(0, 10)
      const r = await api<Body>('/api/promotions', { cookie: customerCookie(org), body: {
        target_type: 'event', target_id: ev.id, placement: 'top_list', city: 'Yaoundé',
        start_date: today, end_date: today, phone_number: '+237670000000',
      } })
      assertEq(r.status, 403, `HTTP 403 (${r.raw.slice(0, 100)})`)
      assertEq(r.body.reason, 'module_off', 'reason module_off')
    })

    await step('Auto-approbation: from the module, not the old flag', async () => {
      const city = testName('city')
      // 🔴 An auto-approved submit publishes at once: the city must have no subscribers.
      const n = await countMatchingSubscribers({ city, category: 'Autre' })
      assertEq(n, 0, 'test city has no subscribers')
      if (n !== 0) return
      const submit = (who: typeof org) => api<{ event?: { id: string; is_active: boolean }; id?: string }>('/api/events/submit', {
        cookie: customerCookie(who),
        body: { title: testName('m4_submit'), date: futureDateISO(15), city, category: 'Autre', ticket_price: 0, organizer_name: 'Asso', cover_photo: testPictureUrl() },
      })
      const flagOnly = await makeCustomer({ suiteNo: 74, name: 'M4 Flag Only', extra: { organizer_modules: ['reservations'], event_auto_approve: true } })
      const a = await submit(flagOnly)
      const { data: ea } = await sb.from('events').select('id, is_active').eq('organizer_id', flagOnly.id).maybeSingle()
      if (ea?.id) track('events', ea.id as string)
      assertEq(a.status, 200, `submit → 200 (${a.raw.slice(0, 100)})`)
      assertEq(ea?.is_active, false, 'flag without the module → waits for review')
      const trusted = await makeCustomer({ suiteNo: 74, name: 'M4 Trusted', extra: { organizer_modules: ['reservations', 'auto_approve'], event_auto_approve: false } })
      await submit(trusted)
      const { data: eb } = await sb.from('events').select('id, is_active').eq('organizer_id', trusted.id).maybeSingle()
      if (eb?.id) track('events', eb.id as string)
      assertEq(eb?.is_active, true, 'module → published at once')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
