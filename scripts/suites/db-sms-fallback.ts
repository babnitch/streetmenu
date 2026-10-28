// D3 — SMS when WhatsApp can't deliver (lib/smsFallback.ts), against the real
// database.
//
// What it pins:
//   - only 63016 / 63015 trigger it, once per message (fallback_sent_at);
//   - a customer login code goes by SMS with the still-valid code;
//   - payment confirmed (customer) and new paid order (restaurant) get an
//     SMS; a booking confirmation to the booker does, the organiser's ping
//     doesn't; other messages and old ones don't;
//   - the login screen's code-channel check sees it.
//
// 🔴 SAFETY. Nothing reaches Twilio: globalThis.fetch answers api.twilio.com
// locally. Every phone is +999 (and the send guard only allows +999).

process.env.TWILIO_SMS_NUMBER = process.env.TWILIO_SMS_NUMBER || '+15005550006'

import { sb, BASE } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { makeCustomer, makeRestaurant, makeOrder, makeEvent } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'db-sms-fallback'

const smsSends: Array<{ to: string; body: string }> = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('api.twilio.com')) {
    const params = new URLSearchParams(String(init?.body ?? ''))
    smsSends.push({ to: params.get('To') ?? '', body: params.get('Body') ?? '' })
    return new Response(JSON.stringify({ sid: `SM_FB_${smsSends.length}`, status: 'queued' }), { status: 201 })
  }
  if (url.includes('pawapay')) return new Response('blocked by test', { status: 599 })
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

async function waLog(to: string, context: string, relatedId: string | null, body = 'x', ageMs = 0): Promise<string> {
  const { data, error } = await sb.from('message_log').insert({
    direction: 'outbound', channel: 'whatsapp', from_number: '+14155238886', to_number: to,
    body, status: 'failed', context, related_id: relatedId,
    created_at: new Date(Date.now() - ageMs).toISOString(),
  } as never).select('id').single()
  if (error || !data) throw new Error(`log insert: ${error?.message}`)
  return (data as { id: string }).id
}

async function main(): Promise<void> {
  const { smsFallbackForLog } = await import('@/lib/smsFallback')
  const { signCodeTicket } = await import('@/lib/auth')
  const codeChannel = async (ticket: string): Promise<{ status: number; channel?: string }> => {
    const r = await realFetch(`${BASE}/api/auth/code-channel?ticket=${encodeURIComponent(ticket)}`)
    const j = await r.json().catch(() => ({})) as { channel?: string }
    return { status: r.status, channel: j.channel }
  }
  try {
    const cust = await makeCustomer({ suiteNo: 64, name: 'Fallback Customer' })

    await step('login code: SMS with the still-valid code, once', async () => {
      await sb.from('verification_codes').delete().eq('phone', cust.phone)
      await sb.from('verification_codes').insert({ phone: cust.phone, code: '246810', expires_at: new Date(Date.now() + 600_000).toISOString(), used: false } as never)
      const ticket = signCodeTicket(cust.phone)
      assertEq((await codeChannel('nope')).status, 400, 'code-channel: a bad ticket → 400')
      assertEq((await codeChannel(ticket)).channel, 'whatsapp', 'code-channel: still WhatsApp before any SMS')
      const id = await waLog(cust.phone, 'verification_code', null, 'Tchop & Ndjoka\nVotre code de vérification : ••••••')
      assertEq(await smsFallbackForLog(id, '30008'), 'skipped', 'another error code → no SMS')
      const before = smsSends.length
      assertEq(await smsFallbackForLog(id, '63016'), 'sent', '63016 → SMS')
      const sms = smsSends[smsSends.length - 1]
      assert(smsSends.length === before + 1 && !/^whatsapp:/.test(sms.to) && sms.body.includes('246810'), 'one SMS, plain number, with the code')
      assertEq(await smsFallbackForLog(id, '63016'), 'skipped', 'a repeated report sends nothing more')
      const { data } = await sb.from('message_log').select('fallback_sent_at').eq('id', id).single()
      assert(!!(data as { fallback_sent_at: string | null }).fallback_sent_at, 'fallback_sent_at set')
      assertEq((await codeChannel(ticket)).channel, 'sms', 'code-channel: the login screen now sees SMS')
    })

    await step('paid order: customer and restaurant get an SMS (63015 too)', async () => {
      const owner = await makeCustomer({ suiteNo: 64, name: 'Fallback Owner' })
      const rest = await makeRestaurant({ ownerId: owner.id, label: 'sms_fallback', whatsapp: owner.phone })
      const order = await makeOrder(rest.id, cust, { extra: { order_type: 'paid_order', payment_status: 'paid' }, total: 4500 })
      const c = await waLog(cust.phone, 'payment_confirmation', order.id)
      assertEq(await smsFallbackForLog(c, '63015'), 'sent', 'customer → SMS')
      assert(/4[\s,.]?500/.test(smsSends[smsSends.length - 1].body), 'customer SMS has the total')
      const v = await waLog(owner.phone, 'payment_confirmation', order.id)
      assertEq(await smsFallbackForLog(v, '63016'), 'sent', 'restaurant → SMS')
      assert(/commande payée|paid order/.test(smsSends[smsSends.length - 1].body), 'restaurant SMS says new paid order')
    })

    await step('booking: the booker gets an SMS, the organiser ping does not', async () => {
      const org = await makeCustomer({ suiteNo: 64, name: 'Fallback Organiser' })
      const ev = await makeEvent({ organizerId: org.id, label: 'sms_fallback', isActive: true })
      const { data: res } = await sb.from('event_reservations').insert({
        event_id: ev.id, customer_id: cust.id, customer_name: cust.name, customer_phone: cust.phone,
        quantity: 1, reservation_status: 'confirmed', reservation_code: 'FB01',
      } as never).select('id').single()
      track('event_reservations', (res as { id: string }).id)
      const b = await waLog(cust.phone, 'event_reservation', ev.id)
      assertEq(await smsFallbackForLog(b, '63016'), 'sent', 'booker → SMS')
      assert(smsSends[smsSends.length - 1].body.includes('FB01'), 'with the booking code')
      const o = await waLog(org.phone, 'event_reservation', ev.id)
      assertEq(await smsFallbackForLog(o, '63016'), 'skipped', 'organiser ping → WhatsApp only')
    })

    await step('other messages and old ones get no SMS', async () => {
      const n = await waLog(cust.phone, 'order_status_update', null)
      assertEq(await smsFallbackForLog(n, '63016'), 'skipped', 'order status update → no SMS')
      await sb.from('verification_codes').delete().eq('phone', cust.phone)
      await sb.from('verification_codes').insert({ phone: cust.phone, code: '135791', expires_at: new Date(Date.now() + 600_000).toISOString(), used: false } as never)
      const old = await waLog(cust.phone, 'verification_code', null, 'code ••••••', 60 * 60_000)
      assertEq(await smsFallbackForLog(old, '63016'), 'skipped', 'a message older than 30 min → no SMS')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
