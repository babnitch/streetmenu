// Protected payments (Prompt P) against the real database.
//
// P1a pins:
//   - the module needs Mobile Money payment (lib + DB check);
//   - a protected order's payment is HELD once (race), with one ledger line,
//     its accept deadline, an audit row; the customer gets the hand-over
//     code in its own message, masked in message_log;
//   - module off or master off → nothing held (today's behaviour);
//   - SANDBOX money is test money: a hold made while PawaPay runs in sandbox
//     is is_test even for a real-looking restaurant and customer;
//   - payout_post 'started' only counts available money with the payout's
//     own is_test (a real payout never sees test money).
//
// 🔴 SAFETY. Nothing reaches Twilio or PawaPay: fetch is stubbed for both,
// every send is counted locally. Every ledger line written here is is_test
// (the ledger is append-only, so no real-looking line may ever be written).

import { randomUUID } from 'crypto'
import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { makeCustomer, makeRestaurant, makeOrder } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { settleDeposit } from '@/lib/payments-settle'
import { clearProtectedSettingsCache, handoverCode, isSandboxMoney } from '@/lib/protectedPayments'
import { toggleModule, validateModules } from '@/lib/modules'

const SUITE = 'db-protected-payments'

// ── Network stub ────────────────────────────────────────────────────────────
interface Sent { to: string; body: string }
const sends: Sent[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('api.twilio.com')) {
    const p = new URLSearchParams(String(init?.body ?? ''))
    sends.push({ to: p.get('To') ?? '', body: p.get('Body') ?? '' })
    return new Response(JSON.stringify({ sid: `SM_TEST_${sends.length}`, status: 'queued' }), { status: 201 })
  }
  if (url.includes('pawapay')) return new Response('blocked by test', { status: 599 })
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

const PROTECTED = ['orders', 'payment', 'payments_protected']
let dep = 0
const depositId = () => testName(`pdep${++dep}`)

async function setMaster(on: boolean): Promise<void> {
  const { error } = await sb.from('platform_settings').upsert({ key: 'test_payments_protected_master', value: on } as never, { onConflict: 'key' })
  if (error) throw new Error(`master: ${error.message}`)
  clearProtectedSettingsCache()
}

type Line = { bucket: string; delta: number; is_test: boolean; party_type: string; kind: string }
async function lines(col: 'order_id' | 'payout_id', id: string): Promise<Line[]> {
  const { data } = await sb.from('money_ledger').select('bucket, delta, is_test, party_type, kind').eq(col, id).order('created_at')
  return (data ?? []) as Line[]
}

async function paidProtectedOrder(restaurantId: string, customer: Awaited<ReturnType<typeof makeCustomer>>, extra: Record<string, unknown> = {}) {
  const d = depositId()
  const o = await makeOrder(restaurantId, customer, { total: 2500, extra: { order_type: 'paid_order', payment_status: 'pending', payment_id: d, ...extra } })
  return { ...o, deposit: d }
}

async function main(): Promise<void> {
  try {
    assert(isSandboxMoney(), 'the test server runs PawaPay in sandbox')
    await setMaster(true)
    const customer = await makeCustomer({ name: 't_protected_payer' })
    const rest = await makeRestaurant({ label: 'protected', modules: PROTECTED })

    await step('module: Paiement protégé needs Mobile Money payment', async () => {
      assertEq(toggleModule('restaurant', [], 'payments_protected', true), ['orders', 'payment', 'payments_protected'], 'ticking it ticks Paiement + Commandes')
      assertEq(toggleModule('restaurant', PROTECTED, 'orders', false), [], 'unticking Commandes unticks both')
      assert(!validateModules('restaurant', ['orders', 'payments_protected']).ok, 'refused without Paiement')
      const { error } = await sb.from('restaurants').update({ modules: ['orders', 'payments_protected'] } as never).eq('id', rest.id)
      assert(!!error, 'the database refuses it too (supabase-protected-payments-module.sql)')
    })

    await step('paid → held once: ledger line, deadline, audit, code masked', async () => {
      const o = await paidProtectedOrder(rest.id, customer)
      const before = sends.length
      const t0 = Date.now()
      const results = await Promise.all([
        settleDeposit(o.deposit, { status: 'COMPLETED', amount: '2500', correspondent: 'MTN_MOMO_CMR' }, 'webhook'),
        settleDeposit(o.deposit, { status: 'COMPLETED', amount: '2500', correspondent: 'MTN_MOMO_CMR' }, 'status_poll'),
      ])
      assertEq(results.map(r => r.kind === 'unknown' ? 'unknown' : r.action).sort(), ['already_settled', 'paid'], 'one caller wins')
      const { data: row } = await sb.from('orders').select('funds_status, accept_deadline, is_test').eq('id', o.id).single()
      assertEq(row?.funds_status, 'held', 'funds_status = held')
      const dl = new Date(row?.accept_deadline as string).getTime() - t0
      assert(dl > 4 * 60_000 && dl < 121 * 60_000, `accept_deadline set from the timeout (${Math.round(dl / 60_000)} min)`)
      assertEq(row?.is_test, true, 'sandbox → orders.is_test')
      const l = await lines('order_id', o.id)
      assertEq(l.map(x => [x.party_type, x.bucket, x.delta, x.is_test]), [['restaurant', 'held', 2500, true]], 'ONE held line of 2500, is_test')
      const { count } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('target_id', o.id).eq('action', 'funds_held')
      assertEq(count, 1, 'one funds_held audit row')

      const toCustomer = sends.slice(before).filter(m => m.to === `whatsapp:${customer.phone}`)
      const code = handoverCode(o.id)
      assertEq(toCustomer.length, 2, 'customer: confirmation + code message')
      assert(/Paiement protégé|Protected payment/.test(toCustomer[0]?.body ?? ''), 'confirmation says the payment is protected')
      assert((toCustomer[1]?.body ?? '').includes(code), 'the code message carries the code')
      const toVendor = sends.slice(before).filter(m => m.to === `whatsapp:${rest.whatsapp}`)
      assert(toVendor.some(m => /retenu par Tchop|held by Tchop/.test(m.body)), 'vendor told it is held')
      assert(!toVendor.some(m => m.body.includes(code)), 'vendor never gets the code')

      const { data: logs } = await sb.from('message_log').select('body').eq('related_id', o.id).eq('context', 'release_code')
      assertEq((logs ?? []).length, 1, 'code message logged once')
      assert(!(logs?.[0]?.body as string).includes(code) && (logs?.[0]?.body as string).includes('••••'), 'logged masked')
    })

    await step('not protected: module off, or master off → nothing held', async () => {
      const plain = await makeRestaurant({ label: 'not_protected', modules: ['orders', 'payment'] })
      const a = await paidProtectedOrder(plain.id, customer)
      await settleDeposit(a.deposit, { status: 'COMPLETED', amount: '2500' }, 'webhook')
      await setMaster(false)
      const b = await paidProtectedOrder(rest.id, customer)
      await settleDeposit(b.deposit, { status: 'COMPLETED', amount: '2500' }, 'webhook')
      await setMaster(true)
      const { data } = await sb.from('orders').select('id, payment_status, funds_status').in('id', [a.id, b.id])
      assert((data ?? []).every(r => r.payment_status === 'paid' && r.funds_status === null), 'both paid, nothing held')
      assertEq((await lines('order_id', a.id)).length + (await lines('order_id', b.id)).length, 0, 'no ledger lines')
    })

    await step('sandbox money is test money, and a real payout never sees it', async () => {
      // A real-looking restaurant (not the test city, not +999), hidden, and
      // a real-looking customer number: only the SANDBOX flag makes it test.
      const real = await makeRestaurant({
        label: 'sandbox_real', modules: PROTECTED, isActive: false, status: 'pending',
        city: 'Yaoundé', whatsapp: '+237650009001',
      })
      const o = await paidProtectedOrder(real.id, customer, { customer_phone: '+237650009002' })
      await settleDeposit(o.deposit, { status: 'COMPLETED', amount: '2500' }, 'webhook')
      assertEq((await lines('order_id', o.id)).map(x => x.is_test), [true], 'held line is test (sandbox)')
      const { data: rel, error: relErr } = await sb.rpc('order_funds_release', { p_order: o.id, p_by: 'admin', p_commission: 0 } as never)
      assert(!relErr && rel === true, `released (${relErr?.message ?? ''})`)
      const after = await lines('order_id', o.id)
      assert(after.length === 4 && after.every(x => x.is_test), 'release lines are test too')

      const day = new Date().toISOString().slice(0, 10)
      const realPayout = randomUUID()
      const { error: e1 } = await sb.from('pro_payouts').insert({ id: realPayout, party_type: 'restaurant', party_id: real.id, amount: 1000, phone: '+237650009001', day } as never)
      assert(!e1, `real payout row (${e1?.message ?? ''})`)
      track('pro_payouts', realPayout)
      const { data: rp } = await sb.from('pro_payouts').select('is_test').eq('id', realPayout).single()
      assertEq(rp?.is_test, false, 'a payout to a real pro in production rules is real')
      const { error: over } = await sb.rpc('payout_post', { p_payout: realPayout, p_phase: 'started' } as never)
      assert(/payout_over_available/.test(over?.message ?? ''), `real payout refused: only test money available (${over?.message ?? 'no error'})`)
      assertEq((await lines('payout_id', realPayout)).length, 0, 'no line written for it')
      await sb.from('pro_payouts').update({ status: 'failed' } as never).eq('id', realPayout)

      const testPayout = randomUUID()
      const { error: e2 } = await sb.from('pro_payouts').insert({ id: testPayout, party_type: 'restaurant', party_id: real.id, amount: 1000, phone: '+237650009001', day, is_test: true } as never)
      assert(!e2, `sandbox payout row (${e2?.message ?? ''})`)
      track('pro_payouts', testPayout)
      const { data: ok1, error: e3 } = await sb.rpc('payout_post', { p_payout: testPayout, p_phase: 'started' } as never)
      assert(!e3 && ok1 === true, `sandbox payout sees the sandbox money (${e3?.message ?? ''})`)
      const { data: ok2 } = await sb.rpc('payout_post', { p_payout: testPayout, p_phase: 'failed' } as never)
      assertEq(ok2, true, 'failed → back to available')
      const pl = await lines('payout_id', testPayout)
      assert(pl.length === 4 && pl.every(x => x.is_test), 'payout lines are test')
      const { data: bal } = await sb.from('money_balances').select('amount').eq('party_id', real.id)
      assertEq((bal ?? []).length, 0, 'no real balance for it at all')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await setMaster(false).catch(() => null)
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }
  finish(SUITE)
}

void main()
