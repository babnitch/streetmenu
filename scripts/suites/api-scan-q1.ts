// Q1 — every booking, order and voucher has a QR that is a LINK:
// https://<site>/scan/<token>. The token is HMAC(secret, kind:id:version),
// 22 characters; only its SHA-256 is stored. The owner gets it (with the
// short code); anyone else 404. One booking (several tiers) = one QR.
// A revoked QR stops resolving. WhatsApp confirmations carry the link.
//
// Every phone is +999.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, makeEvent, makeTier, makeVoucher, futureDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { computeScanToken, hashScanToken, resolveScanToken, revokeScanToken } from '../../lib/scanTokens'

const SUITE = 'api-scan-q1'

interface Mine { url?: string; code?: string; error?: string }
const tokenOf = (url?: string) => (url ?? '').split('/scan/')[1] ?? ''

async function main(): Promise<void> {
  try {
    await step('tokens: 22 characters, stable, different per item and version', () => {
      const id = '11111111-2222-3333-4444-555555555555'
      const t = computeScanToken('order', id)
      assert(/^[A-Za-z0-9_-]{22}$/.test(t), '22 base64url characters')
      assertEq(computeScanToken('order', id), t, 'same item → same token')
      assert(computeScanToken('reservation', id) !== t, 'kind changes it')
      assert(computeScanToken('order', id, 2) !== t, 'version changes it')
      assert(/^[0-9a-f]{64}$/.test(hashScanToken(t)), 'SHA-256 stored')
    })

    const buyer = await makeCustomer({ suiteNo: 84, name: 'Q1 Buyer' })
    const other = await makeCustomer({ suiteNo: 84, name: 'Q1 Other' })
    const bc = customerCookie(buyer)
    const mine = (kind: string, id: string, cookie?: string) => api<Mine>(`/api/scan/mine?kind=${kind}&id=${id}`, { cookie })

    await step('order: the owner gets the link + code; others 404; logged out 401', async () => {
      const rest = await makeRestaurant({ label: 'q1_r' })
      const o = await makeOrder(rest.id, buyer, { status: 'confirmed' })
      const r = await mine('order', o.id, bc)
      assertEq(r.status, 200, `200 (${r.raw.slice(0, 80)})`)
      assert(/\/scan\/[A-Za-z0-9_-]{22}$/.test(r.body.url ?? ''), 'link /scan/<token>')
      assertEq(r.body.code, o.id.replace(/-/g, '').slice(-4).toUpperCase(), 'short code')
      assertEq(await resolveScanToken(tokenOf(r.body.url)), { kind: 'order', id: o.id }, 'resolves to the order')
      const { data } = await sb.from('scan_tokens').select('token_hash').eq('target_id', o.id)
      assertEq(data?.[0]?.token_hash, hashScanToken(tokenOf(r.body.url)), 'only the hash is stored')
      assertEq((await mine('order', o.id, customerCookie(other))).status, 404, 'someone else → 404')
      assertEq((await mine('order', o.id)).status, 401, 'logged out → 401')
      assertEq((await mine('order', o.id, bc)).body.url, r.body.url, 'same link next time')
    })

    await step('a revoked QR stops resolving; the new one works', async () => {
      const rest = await makeRestaurant({ label: 'q1_r2' })
      const o = await makeOrder(rest.id, buyer, { status: 'confirmed' })
      const before = tokenOf((await mine('order', o.id, bc)).body.url)
      await revokeScanToken('order', o.id)
      assertEq(await resolveScanToken(before), null, 'old QR dead')
      const after = tokenOf((await mine('order', o.id, bc)).body.url)
      assert(after !== before, 'new token')
      assertEq(await resolveScanToken(after), { kind: 'order', id: o.id }, 'new QR works')
      assertEq(await resolveScanToken('not-a-token'), null, 'garbage → null')
    })

    await step('voucher: the claimed voucher\'s QR is a link', async () => {
      const v = await makeVoucher({ label: 'q1v' })
      const { data: cv } = await sb.from('customer_vouchers').insert({ customer_id: buyer.id, voucher_id: v.id }).select('id').single()
      track('customer_vouchers', cv!.id as string)
      const r = await mine('voucher', cv!.id as string, bc)
      assertEq(r.status, 200, `200 (${r.raw.slice(0, 80)})`)
      assertEq(r.body.code, v.code, 'code = the voucher code')
      assertEq((await mine('voucher', cv!.id as string, customerCookie(other))).status, 404, 'not yours → 404')
    })

    await step('booking with two tiers = one QR; the confirmation carries the link', async () => {
      const ev = await makeEvent({ label: 'q1_event', isActive: true, date: futureDateISO(5) })
      const a = await makeTier(ev.id, { name: 'A', price: 0, maxQuantity: 10 })
      const b = await makeTier(ev.id, { name: 'B', price: 0, maxQuantity: 10 })
      const res = await api<{ reservation_ids?: string[] }>(`/api/events/${ev.id}/reserve`, {
        cookie: bc, body: { items: [{ tier_id: a.id, quantity: 2 }, { tier_id: b.id, quantity: 1 }] },
      })
      for (const id of res.body.reservation_ids ?? []) track('event_reservations', id)
      assertEq(res.status, 200, `booked (${res.raw.slice(0, 80)})`)
      const [r1, r2] = res.body.reservation_ids ?? []
      const u1 = (await mine('reservation', r1, bc)).body.url
      const u2 = (await mine('reservation', r2, bc)).body.url
      assert(!!u1 && u1 === u2, 'both tiers → the same QR')
      assertEq(await resolveScanToken(tokenOf(u1)), { kind: 'reservation', id: r1 }, 'points at the booking')
      const { data } = await sb.from('message_log').select('body').eq('related_id', ev.id).like('to_number', `%${buyer.phone.replace('+', '')}%`)
      assert((data ?? []).some(m => String(m.body).includes(`/scan/${tokenOf(u1)}`)), 'WhatsApp confirmation has the QR link')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
