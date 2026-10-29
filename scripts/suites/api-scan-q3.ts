// Q3 — the in-app scanner and the typed code for events.
// The scanner reads only our /scan/<token> links. An event's booking code
// opens the same check screen (validated "by code"). The organiser's manual
// "present" button records the same check-in, so the QR then says "already
// used" (no second entry).
//
// Every phone is +999; per-run city.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeEvent } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { tokenFromScan } from '../../lib/shortCode'
import { ensureScanToken } from '../../lib/scanTokens'
import { dateInZone } from '../../lib/offers'

const SUITE = 'api-scan-q3'
const CITY = testName('city')

async function main(): Promise<void> {
  try {
    await step('the scanner reads only our links', () => {
      const t = 'Ab3_dE5-fG7hI9jK1lM2nO'
      assertEq(tokenFromScan(`https://streetmenu.vercel.app/scan/${t}`), t, 'production link')
      assertEq(tokenFromScan(`https://preview-x.vercel.app/scan/${t}?utm=1`), t, 'preview link, query ignored')
      assertEq(tokenFromScan(` https://streetmenu.vercel.app/scan/${t}\n`), t, 'spaces trimmed')
      assertEq(tokenFromScan('a3f0c2e4-1111-2222-3333-444455556666'), null, 'a raw id (old voucher QR) is not ours')
      assertEq(tokenFromScan(`https://evil.example/scan/${t}x`), null, 'wrong length')
      assertEq(tokenFromScan('WIFI:S:cafe;T:WPA;P:x;;'), null, 'other QR')
    })

    const org = await makeCustomer({ suiteNo: 86, name: 'Q3 Organiser' })
    const buyer = await makeCustomer({ suiteNo: 86, name: 'Q3 Buyer', extra: { city: CITY } })
    const stranger = await makeCustomer({ suiteNo: 86, name: 'Q3 Stranger' })
    const oc = customerCookie(org)
    const ev = await makeEvent({ organizerId: org.id, label: 'q3_event', isActive: true, date: dateInZone('Africa/Douala'), city: CITY })
    const book = async () => {
      const r = await api<{ reservation_ids?: string[]; reservation_code?: string }>(`/api/events/${ev.id}/reserve`, { cookie: customerCookie(buyer), body: { quantity: 2 } })
      for (const id of r.body.reservation_ids ?? []) track('event_reservations', id)
      return { id: r.body.reservation_ids![0], code: r.body.reservation_code! }
    }

    await step('event code → same screen; validated by code; strangers can\'t look up', async () => {
      const b = await book()
      assertEq((await api('/api/scan/code', { cookie: customerCookie(stranger), body: { event_id: ev.id, code: b.code } })).status, 403, 'stranger → 403')
      const c = await api<{ token?: string }>('/api/scan/code', { cookie: oc, body: { event_id: ev.id, code: `#${b.code.toLowerCase()}` } })
      assertEq(c.status, 200, 'found, "#" and case ignored')
      const p = await api(`/api/scan/${c.body.token}`, { method: 'POST', cookie: oc, body: { via: 'code' } })
      assertEq(p.status, 200, 'checked in')
      const { data } = await sb.from('event_checkins').select('via, people').eq('reservation_id', b.id).single()
      assertEq([data!.via, data!.people], ['code', 2], 'recorded "by code", 2 people')
      assertEq((await api('/api/scan/code', { cookie: oc, body: { event_id: ev.id, code: 'ZZZZ' } })).status, 404, 'unknown code → 404')
    })

    await step('manual "present" = the same check-in: the QR then says already used', async () => {
      const b = await book()
      assertEq((await api(`/api/events/${ev.id}/reservations/${b.id}/attend`, { method: 'POST', cookie: oc, body: {} })).status, 200, 'marked present')
      const v = await api<{ state?: string }>(`/api/scan/${await ensureScanToken('reservation', b.id)}`, { cookie: oc })
      assertEq(v.body.state, 'used', 'QR: already used')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
