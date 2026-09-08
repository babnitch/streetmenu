// TEST-PLAN.md §1c #28 (check-phone / send-code) and #37 partial (customer
// history: orders linked to the session's customer_id).
//
// Ported from:
//   scripts/test-check-phone.ts
//   scripts/test-order-page-session.ts
//
// Two deliberate changes, both ruled on before porting:
//
// 1. send-code's happy path is a warn(), not an assert. The original expected
//    HTTP 200 + sent:true. app/api/auth/send-code/route.ts:99 now returns 502
//    when BOTH WhatsApp and the SMS fallback fail, which is what happens on
//    any machine without working Twilio credentials — and §3 rules out making
//    the suite depend on live Twilio. The 502 is correct behaviour (nothing
//    was delivered, so saying "sent" would be a lie), and the expectation was
//    written before the SMS fallback existed. Everything about that call that
//    does NOT depend on delivery — no duplicate customer row, the
//    verification_codes row, the needsRegistration branch — stays a hard
//    assertion, because the code row is written before the send is attempted.
//
// 2. The original grabbed a REAL restaurant with
//    `select('id').eq('is_active',true).limit(1)` and inserted orders against
//    it. That is a live-data write from a regression suite; it now creates its
//    own restaurant. Its "/order bundle contains /api/auth/me" greps are also
//    gone — they scanned minified JS to prove a deploy was live, which is not
//    a behaviour assertion and breaks on any bundling change. The /order → 200
//    check is kept.

import { sb } from '../testkit/env'
import { assert, assertEq, warn, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-auth-and-profile'

interface CheckPhoneBody { exists?: boolean; name?: string | null; normalizedPhone?: string }
interface SendCodeBody { sent?: boolean; needsRegistration?: boolean; channel?: string; error?: string }

async function countCustomers(phone: string): Promise<number> {
  const { count } = await sb.from('customers').select('*', { count: 'exact', head: true }).eq('phone', phone)
  return count ?? 0
}

async function main(): Promise<void> {
  try {
    // ── #28 check-phone / send-code ────────────────────────────────────────
    const known = await makeCustomer({ suiteNo: 28, name: 'Test WA Customer' })
    // Never inserted — the "unknown phone" side of every assertion below.
    const unknownPhone = '+999280099'

    await step('check-phone finds the customer across every equivalent format', async () => {
      const variants = [
        known.phone,                                    // exact
        known.phone.replace('+', ''),                   // missing +
        known.phone.replace(/^(\+\d{3})(\d{3})(\d+)$/, '$1 $2 $3'),   // spaces
        known.phone.replace(/^(\+\d{3})(\d{3})(\d+)$/, '$1-$2-$3'),   // dashes
        `  ${known.phone}  `,                           // surrounding whitespace
        `00${known.phone.slice(1)}`,                    // 00 international prefix
        `00 ${known.phone.slice(1, 4)} ${known.phone.slice(4)}`,      // 00 with spaces
      ]
      for (const v of variants) {
        const r = await api<CheckPhoneBody>(`/api/auth/check-phone?phone=${encodeURIComponent(v)}`)
        assertEq(r.status, 200, `${JSON.stringify(v)} → HTTP 200`)
        assertEq(r.body.exists, true, `${JSON.stringify(v)} → exists=true`)
        assertEq(r.body.name, known.name, `${JSON.stringify(v)} → name matches`)
        assertEq(r.body.normalizedPhone, known.phone, `${JSON.stringify(v)} → normalized to E.164`)
      }
    })

    await step('check-phone returns exists:false for an unknown phone', async () => {
      const r = await api<CheckPhoneBody>(`/api/auth/check-phone?phone=${encodeURIComponent(unknownPhone)}`)
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.exists, false, 'exists=false')
      assertEq(r.body.name, null, 'name=null')
    })

    await step('check-phone rejects empty input', async () => {
      const r = await api('/api/auth/check-phone?phone=')
      assertEq(r.status, 400, 'HTTP 400 for empty phone')
    })

    await step('send-code for an existing customer creates no duplicate', async () => {
      // Deliberately messy input: send-code must normalize it the same way
      // check-phone does and find the existing row rather than insert one.
      const messy = known.phone.replace(/^(\+\d{3})(\d{3})(\d+)$/, '$1 $2 $3')
      const r = await api<SendCodeBody>('/api/auth/send-code', { body: { phone: messy } })

      if (r.status === 200) {
        assertEq(r.body.sent, true, 'sent=true')
        assertEq(r.body.needsRegistration, undefined, 'no needsRegistration flag for a known customer')
      } else {
        // Delivery-dependent, not a code defect — see the header note.
        warn(`send-code returned ${r.status}, not 200`,
          `no channel could deliver in this environment (${(r.body as SendCodeBody)?.error ?? r.raw.slice(0, 80)}). ` +
          'Correct per route.ts:99; asserting 200 would require live Twilio, which §3 excludes.')
      }

      // Delivery-independent, so these stay hard.
      assertEq(await countCustomers(known.phone), 1, 'still exactly 1 customer row (no dup)')
    })

    await step('send-code for an unknown customer → needsRegistration, no row created', async () => {
      // This branch returns at route.ts:47, before any send is attempted, so
      // it is unaffected by Twilio.
      const r = await api<SendCodeBody>('/api/auth/send-code', { body: { phone: unknownPhone } })
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.needsRegistration, true, 'needsRegistration=true')
      assertEq(await countCustomers(unknownPhone), 0, 'no customer row created yet')
    })

    await step('a fresh verification code is issued for the known customer', async () => {
      // The code row is inserted before the send is attempted, so this holds
      // whether or not delivery succeeded.
      const { data } = await sb.from('verification_codes').select('phone, used').eq('phone', known.phone)
      assertEq((data ?? []).length, 1, 'exactly one fresh code issued')
      assertEq((data as Array<{ used: boolean }>)[0]?.used, false, 'fresh code not yet used')
    })

    // ── #37 partial: session identity and customer history ─────────────────
    const buyer = await makeCustomer({ suiteNo: 37, name: 'Test Checkout' })
    const rest  = await makeRestaurant({ label: 'checkout_rest' })
    const cookie = customerCookie(buyer)

    await step('/api/auth/me with a session returns that customer', async () => {
      const r = await api<{ user?: { id: string; role: string; name: string; phone: string } }>(
        '/api/auth/me', { cookie },
      )
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.user?.role, 'customer', 'role=customer')
      assertEq(r.body.user?.id, buyer.id, 'id matches the seeded customer')
      assertEq(r.body.user?.name, buyer.name, 'name matches')
      assertEq(r.body.user?.phone, buyer.phone, 'phone matches')
    })

    await step('/order renders without a 500', async () => {
      const r = await api('/order', { cookie })
      assertEq(r.status, 200, '/order HTTP 200')
    })

    let linkedOrderId = ''
    await step('a logged-in order is linked to customer_id', async () => {
      const o = await makeOrder(rest.id, buyer, { status: 'pending', total: 2500 })
      linkedOrderId = o.id
      const { data } = await sb.from('orders').select('customer_id').eq('id', o.id).maybeSingle()
      assertEq((data as { customer_id?: string } | null)?.customer_id, buyer.id, 'order linked to customer_id')
    })

    await step('a guest order has a null customer_id', async () => {
      const { data, error } = await sb.from('orders').insert({
        restaurant_id: rest.id,
        customer_name: 'Guest',
        customer_phone: '+999370099',
        items: [{ name: 'Eru', quantity: 1, price: 2000 }],
        total_price: 2000,
        status: 'pending',
        customer_id: null,
      } as never).select('id, customer_id').single()
      assert(!error, `guest order inserted${error ? ` — ${error.message}` : ''}`)
      const row = data as unknown as { id: string; customer_id: string | null }
      track('orders', row.id)
      assertEq(row.customer_id, null, 'guest order has null customer_id')
    })

    await step('"mes commandes" scoped to customer_id returns only the linked order', async () => {
      const { data } = await sb.from('orders').select('id, customer_id')
        .eq('customer_id', buyer.id).order('created_at', { ascending: false })
      assertEq((data ?? []).length, 1, 'exactly one order in "mes commandes"')
      assertEq((data as Array<{ id: string }>)[0]?.id, linkedOrderId, 'it is the logged-in order, not the guest one')
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
