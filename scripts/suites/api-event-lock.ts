// The organiser's booking lock (events.reservations_open = false):
//   - the event page reads it with the public key (it shows "Réservations
//     fermées" and no booking button — app/events/[id]/page.tsx);
//   - web: /reserve and /pay refuse (409);
//   - WhatsApp: "reserver XXXX" and the "evenements" → "reserver" path both
//     refuse, with no booking and no booking session;
//   - reopened, the same booking goes through.

import { sb, getAnon } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeEvent } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-event-lock'
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const send = (from: string, body: string) => api('/api/whatsapp/incoming', { form: { From: `whatsapp:${from}`, Body: body } })

async function main(): Promise<void> {
  try {
    const buyer = await makeCustomer({ suiteNo: 42, name: 'Buyer' })
    const ev = await makeEvent({ label: 'lock_event', isActive: true, extra: { reservations_open: false } })
    const cookie = customerCookie(buyer)
    const code4 = ev.id.replace(/-/g, '').slice(-4)
    const bookings = async () => (await sb.from('event_reservations').select('id', { count: 'exact', head: true }).eq('event_id', ev.id)).count ?? 0
    await sb.from('signup_sessions').delete().eq('phone', buyer.phone)

    await step('event page data: the lock is public', async () => {
      const { data, error } = await getAnon().from('events').select('id, reservations_open').eq('id', ev.id).maybeSingle()
      assert(!error, `readable (${error?.message ?? 'ok'})`)
      assertEq(data?.reservations_open, false, 'reservations_open = false')
    })

    await step('web: reserve and pay refused', async () => {
      const r = await api<{ error?: string }>(`/api/events/${ev.id}/reserve`, { cookie, body: { quantity: 1 } })
      assertEq(r.status, 409, 'reserve → 409')
      assert(/fermées|closed/i.test(r.body.error ?? ''), `says closed (${r.body.error})`)
      const p = await api<{ error?: string }>(`/api/events/${ev.id}/pay`, { cookie, body: { quantity: 1, phoneNumber: '+237653456789' } })
      assertEq(p.status, 409, 'pay → 409')
      assertEq(await bookings(), 0, 'no booking')
    })

    await step('WhatsApp: "reserver XXXX" refused', async () => {
      await send(buyer.phone, `reserver ${code4}`)
      await sleep(1200)
      const { data: s } = await sb.from('signup_sessions').select('user_type').eq('phone', buyer.phone).maybeSingle()
      assert(s?.user_type !== 'event_reserve', 'no booking session')
      assertEq(await bookings(), 0, 'no booking')
    })

    await step('WhatsApp: event detail → "reserver" refused', async () => {
      await sb.from('signup_sessions').upsert({
        phone: buyer.phone, user_type: 'event_detail', step: 1,
        data: { event_id: ev.id, event_name: ev.title }, expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      })
      await send(buyer.phone, 'reserver')
      await sleep(1200)
      const { data: s } = await sb.from('signup_sessions').select('user_type').eq('phone', buyer.phone).maybeSingle()
      assert(s?.user_type !== 'event_reserve', `no booking session (${s?.user_type ?? 'none'})`)
      assertEq(await bookings(), 0, 'no booking')
    })

    await step('reopened: the same web booking goes through', async () => {
      await sb.from('events').update({ reservations_open: true } as never).eq('id', ev.id)
      const r = await api<{ reservation_id?: string }>(`/api/events/${ev.id}/reserve`, { cookie, body: { quantity: 1 } })
      if (r.body.reservation_id) track('event_reservations', r.body.reservation_id)
      assertEq(r.status, 200, `reserve 200 (${r.raw.slice(0, 120)})`)
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
