// TEST-PLAN.md §1c #24 — the voucher system over HTTP.
// Ported from scripts/test-vouchers.ts with the same assertions.
//
// One residue fix. The original created a real auto-coded voucher through the
// admin API, deleted it with an HTTP call, and backstopped that in cleanup
// with:
//     .ilike('code', 'TCHOP-%__test__%')
// Real auto-codes are TCHOP-XXXX, so that pattern can never match — if the
// HTTP DELETE failed, a stray voucher survived under a name no sweeper
// pattern covers. The id is tracked in the ledger now, so teardown removes it
// whatever happens to the DELETE.
//
// Customers are seeded by direct insert (makeCustomer), never through the
// API, so assignWelcomeVoucher never fires and the global BIENVENUE counter
// is untouched — §4 hazard 2.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeVoucher } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-vouchers'

interface ApplyBody { discount?: number; finalTotal?: number; reason?: string }
interface VoucherBody { ok?: boolean; voucher?: { id: string; code: string; restaurant_id?: string | null } }

async function main(): Promise<void> {
  try {
    const buyer    = await makeCustomer({ suiteNo: 24, name: 'Buyer' })
    const owner    = await makeCustomer({ suiteNo: 24, name: 'Owner' })

    const rest      = await makeRestaurant({ ownerId: owner.id, label: 'vch_r1', whatsapp: owner.phone })
    const otherRest = await makeRestaurant({ label: 'vch_r2' })

    const platformVoucher   = await makeVoucher({ label: 'plat10', discountType: 'percent', discountValue: 10 })
    const restaurantVoucher = await makeVoucher({ label: 'r500', discountType: 'fixed', discountValue: 500, restaurantId: rest.id })
    const expiredVoucher    = await makeVoucher({ label: 'expired', discountType: 'percent', discountValue: 20,
                                                  expiresAt: '2000-01-01T00:00:00Z' })

    const cookie = customerCookie(buyer)
    const ownerC = customerCookie(owner)
    const admin  = await adminCookie()

    await step('BIENVENUE exists in the DB', async () => {
      const { data } = await sb.from('vouchers').select('id').eq('code', 'BIENVENUE').maybeSingle()
      assert(!!data, 'BIENVENUE voucher seeded')
    })

    await step('a customer can claim a platform voucher', async () => {
      const r = await api(`/api/customer/vouchers/claim`, { cookie, body: { code: platformVoucher.code } })
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
    })

    await step('double-claim is rejected (per-customer max = 1)', async () => {
      const r = await api(`/api/customer/vouchers/claim`, { cookie, body: { code: platformVoucher.code } })
      assertEq(r.status, 409, 'HTTP 409')
    })

    await step('applying a platform voucher returns the right discount', async () => {
      const r = await api<ApplyBody>(`/api/customer/vouchers/apply`, {
        cookie, body: { code: platformVoucher.code, restaurantId: rest.id, orderTotal: 5000 },
      })
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.discount, 500, '10% of 5000 = 500')
      assertEq(r.body.finalTotal, 4500, 'final total 4500')
    })

    await step('a restaurant-scoped voucher rejects other restaurants', async () => {
      const r = await api<ApplyBody>(`/api/customer/vouchers/apply`, {
        cookie, body: { code: restaurantVoucher.code, restaurantId: otherRest.id, orderTotal: 5000 },
      })
      assertEq(r.status, 400, 'HTTP 400')
      assertEq(r.body.reason, 'wrong_restaurant', 'reason=wrong_restaurant')
    })

    await step('an expired voucher is rejected', async () => {
      const r = await api<ApplyBody>(`/api/customer/vouchers/apply`, {
        cookie, body: { code: expiredVoucher.code, restaurantId: rest.id, orderTotal: 5000 },
      })
      assertEq(r.body.reason, 'expired', 'reason=expired')
    })

    await step('admin POST auto-generates a TCHOP-XXXX code when none is given', async () => {
      const r = await api<VoucherBody>('/api/admin/vouchers', {
        cookie: admin, body: { code: '', discount_type: 'percent', discount_value: 5, per_customer_max: 1 },
      })
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 200)})`)
      const created = r.body.voucher
      assert(!!created, 'a voucher came back')
      if (created) {
        // Track BEFORE asserting: the ledger must own this row even if the
        // pattern assertion below fails. The auto-code is outside the
        // reserved namespace, so the sweeper cannot see it.
        track('vouchers', created.id)
        assert(/^TCHOP-[A-Z0-9]{4}$/.test(created.code), `auto code matches TCHOP-XXXX (got ${created.code})`)
        const del = await api(`/api/admin/vouchers/${created.id}`, { method: 'DELETE', cookie: admin })
        assertEq(del.status, 200, 'an unused auto-code voucher deletes cleanly')
      }
    })

    await step('admin DELETE refuses a voucher that has been used', async () => {
      await sb.from('vouchers').update({ current_uses: 1, uses_count: 1 } as never).eq('id', platformVoucher.id)
      const r = await api(`/api/admin/vouchers/${platformVoucher.id}`, { method: 'DELETE', cookie: admin })
      assertEq(r.status, 409, 'HTTP 409 for used-voucher delete')
      // Reset so teardown can remove it.
      await sb.from('vouchers').update({ current_uses: 0, uses_count: 0 } as never).eq('id', platformVoucher.id)
    })

    await step('vendor POST only accepts their own restaurant', async () => {
      const bad = await api('/api/vendor/vouchers', {
        cookie: ownerC, body: { restaurant_id: otherRest.id, discount_type: 'percent', discount_value: 5 },
      })
      assertEq(bad.status, 403, 'HTTP 403 for a restaurant they do not own')

      const good = await api<VoucherBody>('/api/vendor/vouchers', {
        cookie: ownerC, body: { restaurant_id: rest.id, discount_type: 'percent', discount_value: 5 },
      })
      assertEq(good.status, 200, `HTTP 200 (body ${good.raw.slice(0, 160)})`)
      if (good.body.voucher) {
        // Same reasoning as the admin auto-code: track it before asserting.
        track('vouchers', good.body.voucher.id)
        assertEq(good.body.voucher.restaurant_id, rest.id, 'voucher linked to their restaurant')
      }
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
