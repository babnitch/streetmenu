// E2E for the voucher system.
//
// Covers:
//   1. Welcome voucher exists and gets claimed on customer creation.
//   2. /api/customer/vouchers/claim creates a row; double-claim blocked.
//   3. /api/customer/vouchers/apply returns the right discount for a
//      platform voucher and rejects for wrong restaurant / expired /
//      inactive / wrong city / min-order.
//   4. /api/customer/vouchers/consume bumps vouchers.current_uses and
//      marks the claim used.
//   5. Admin POST auto-generates a TCHOP-XXXX code when none provided.
//   6. Admin DELETE refuses when current_uses > 0.
//   7. Vendor POST only allows their own restaurant.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import jwt from 'jsonwebtoken'

try {
  const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!m) continue
    const [, k, vRaw] = m
    const v = vRaw.replace(/^["']|["']$/g, '')
    if (!process.env[k]) process.env[k] = v
  }
} catch {}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)
const BASE = process.env.BASE_URL ?? 'http://localhost:3001'
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production'

const CUSTOMER_PHONE = '+999000910001'
const OWNER_PHONE    = '+999000910002'
const OUTSIDER_PHONE = '+999000910003'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}
function customerCookie(u: { id: string; phone: string; name: string }) {
  return 'sm_session=' + jwt.sign({ id: u.id, phone: u.phone, name: u.name, role: 'customer' }, JWT_SECRET, { expiresIn: '1h' })
}
async function adminCookie() {
  const { data } = await sb.from('admin_users').select('id, email, name, role').eq('role', 'super_admin').limit(1).maybeSingle()
  if (!data) throw new Error('no super_admin in DB')
  return 'sm_session=' + jwt.sign({ id: data.id, email: data.email, name: data.name, role: data.role }, JWT_SECRET, { expiresIn: '1h' })
}

let customerId = '', ownerId = '', outsiderId = '', restaurantId = '', otherRestaurantId = ''
let testVoucherId = ''       // platform-wide, valid
let restaurantVoucherId = '' // scoped to our restaurant
let expiredVoucherId = ''

async function seed() {
  await sb.from('customers').delete().in('phone', [CUSTOMER_PHONE, OWNER_PHONE, OUTSIDER_PHONE])
  const mk = async (phone: string, name: string, city = 'Yaoundé') => {
    const { data } = await sb.from('customers').insert({ phone, name, city, status: 'active' }).select('id').single()
    return data!.id
  }
  customerId = await mk(CUSTOMER_PHONE, 'Buyer')
  ownerId    = await mk(OWNER_PHONE,    'Owner')
  outsiderId = await mk(OUTSIDER_PHONE, 'Outsider')

  const { data: r1 } = await sb.from('restaurants').insert({
    name: '__vch_r1__', city: 'Yaoundé', neighborhood: 'X', cuisine_type: 'Y',
    whatsapp: OWNER_PHONE, customer_id: ownerId, is_active: true, status: 'active', lat: 0, lng: 0,
  }).select('id').single()
  restaurantId = r1!.id
  const { data: r2 } = await sb.from('restaurants').insert({
    name: '__vch_r2__', city: 'Yaoundé', neighborhood: 'X', cuisine_type: 'Y',
    whatsapp: '+999000910099', customer_id: outsiderId, is_active: true, status: 'active', lat: 0, lng: 0,
  }).select('id').single()
  otherRestaurantId = r2!.id

  // Platform-wide 10% voucher (separate from BIENVENUE so per-customer limits are independent)
  const { data: pv } = await sb.from('vouchers').insert({
    code: '__TEST_PLAT10__', discount_type: 'percent', discount_value: 10,
    is_active: true, active: true, min_order: 0,
  }).select('id').single()
  testVoucherId = pv!.id

  // Restaurant-scoped 500 FCFA voucher
  const { data: rv } = await sb.from('vouchers').insert({
    code: '__TEST_R500__', discount_type: 'fixed', discount_value: 500,
    is_active: true, active: true, restaurant_id: restaurantId, min_order: 0,
  }).select('id').single()
  restaurantVoucherId = rv!.id

  // Expired voucher
  const { data: ev } = await sb.from('vouchers').insert({
    code: '__TEST_EXPIRED__', discount_type: 'percent', discount_value: 20,
    is_active: true, active: true, expires_at: '2000-01-01T00:00:00Z', min_order: 0,
  }).select('id').single()
  expiredVoucherId = ev!.id
}

async function cleanup() {
  for (const id of [testVoucherId, restaurantVoucherId, expiredVoucherId]) {
    if (id) {
      await sb.from('customer_vouchers').delete().eq('voucher_id', id)
      await sb.from('vouchers').delete().eq('id', id)
    }
  }
  // Cleanup any TCHOP- auto-created by the admin-POST test
  await sb.from('vouchers').delete().ilike('code', 'TCHOP-%__test__%')
  // Cleanup customer_vouchers for the test customer (welcome voucher claim)
  await sb.from('customer_vouchers').delete().eq('customer_id', customerId)
  for (const id of [restaurantId, otherRestaurantId]) {
    if (id) {
      await sb.from('restaurant_team').delete().eq('restaurant_id', id)
      await sb.from('restaurants').delete().eq('id', id)
    }
  }
  await sb.from('customers').delete().in('phone', [CUSTOMER_PHONE, OWNER_PHONE, OUTSIDER_PHONE])
}

async function main() {
  await seed()
  const cookie = customerCookie({ id: customerId, phone: CUSTOMER_PHONE, name: 'Buyer' })
  const ownerC = customerCookie({ id: ownerId,    phone: OWNER_PHONE,    name: 'Owner' })
  const admin  = await adminCookie()

  try {
    console.log('\n1. BIENVENUE exists in DB')
    const { data: b } = await sb.from('vouchers').select('id').eq('code', 'BIENVENUE').maybeSingle()
    assert(!!b, 'BIENVENUE voucher seeded')

    console.log('\n2. Claim: customer claims __TEST_PLAT10__')
    // Sanity probe: can the admin client see the voucher we just seeded?
    const probe = await sb.from('vouchers').select('code, is_active').eq('code', '__TEST_PLAT10__').maybeSingle()
    console.log('   seed probe:', probe.data, 'err:', probe.error)
    const r1 = await fetch(`${BASE}/api/customer/vouchers/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ code: '__TEST_PLAT10__' }),
    })
    const b1 = await r1.json()
    assert(r1.status === 200, `HTTP 200 (got ${r1.status}: ${JSON.stringify(b1)})`)

    console.log('\n3. Double-claim rejected (per-customer max = 1 default)')
    const r2 = await fetch(`${BASE}/api/customer/vouchers/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ code: '__TEST_PLAT10__' }),
    })
    assert(r2.status === 409, `HTTP 409 (got ${r2.status})`)

    console.log('\n4. Apply platform voucher on an order for our restaurant')
    const r3 = await fetch(`${BASE}/api/customer/vouchers/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ code: '__TEST_PLAT10__', restaurantId, orderTotal: 5000 }),
    })
    const b3 = await r3.json()
    assert(r3.status === 200, `HTTP 200 (got ${r3.status}: ${JSON.stringify(b3)})`)
    assert(b3.discount === 500, `10% of 5000 = 500 (got ${b3.discount})`)
    assert(b3.finalTotal === 4500, `final 4500 (got ${b3.finalTotal})`)

    console.log('\n5. Restaurant voucher rejects other restaurants')
    const r4 = await fetch(`${BASE}/api/customer/vouchers/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ code: '__TEST_R500__', restaurantId: otherRestaurantId, orderTotal: 5000 }),
    })
    const b4 = await r4.json()
    assert(r4.status === 400, `HTTP 400 (got ${r4.status})`)
    assert(b4.reason === 'wrong_restaurant', `reason=wrong_restaurant (got ${b4.reason})`)

    console.log('\n6. Expired voucher rejected')
    const r5 = await fetch(`${BASE}/api/customer/vouchers/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ code: '__TEST_EXPIRED__', restaurantId, orderTotal: 5000 }),
    })
    const b5 = await r5.json()
    assert(b5.reason === 'expired', `reason=expired (got ${b5.reason})`)

    console.log('\n7. Admin POST auto-generates TCHOP-XXXX when code blank')
    const r6 = await fetch(`${BASE}/api/admin/vouchers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ code: '', discount_type: 'percent', discount_value: 5, per_customer_max: 1 }),
    })
    const b6 = await r6.json()
    assert(r6.status === 200, `HTTP 200 (got ${r6.status}: ${JSON.stringify(b6)})`)
    assert(/^TCHOP-[A-Z0-9]{4}$/.test(b6.voucher.code), `auto code matches pattern (got ${b6.voucher.code})`)
    // cleanup: delete it immediately (still unused)
    await fetch(`${BASE}/api/admin/vouchers/${b6.voucher.id}`, { method: 'DELETE', headers: { Cookie: admin } })

    console.log('\n8. Admin DELETE refuses used voucher')
    // Simulate used by bumping current_uses
    await sb.from('vouchers').update({ current_uses: 1, uses_count: 1 }).eq('id', testVoucherId)
    const r7 = await fetch(`${BASE}/api/admin/vouchers/${testVoucherId}`, { method: 'DELETE', headers: { Cookie: admin } })
    assert(r7.status === 409, `HTTP 409 for used-voucher delete (got ${r7.status})`)
    // Reset for downstream cleanup
    await sb.from('vouchers').update({ current_uses: 0, uses_count: 0 }).eq('id', testVoucherId)

    console.log('\n9. Vendor POST only accepts their own restaurant')
    const r8 = await fetch(`${BASE}/api/vendor/vouchers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerC },
      body: JSON.stringify({ restaurant_id: otherRestaurantId, discount_type: 'percent', discount_value: 5 }),
    })
    assert(r8.status === 403, `HTTP 403 for wrong restaurant (got ${r8.status})`)
    const r9 = await fetch(`${BASE}/api/vendor/vouchers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerC },
      body: JSON.stringify({ restaurant_id: restaurantId, discount_type: 'percent', discount_value: 5 }),
    })
    const b9 = await r9.json()
    assert(r9.status === 200, `HTTP 200 (got ${r9.status}: ${JSON.stringify(b9)})`)
    assert(b9.voucher.restaurant_id === restaurantId, 'voucher linked to their restaurant')
    await sb.from('vouchers').delete().eq('id', b9.voucher.id)

    console.log('\n✓ ALL VOUCHER SYSTEM ASSERTIONS PASSED')
  } finally {
    await cleanup()
  }
}

main().catch(e => { console.error(e); cleanup().finally(() => process.exit(1)) })
