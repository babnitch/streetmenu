// E2E for POST /api/orders/[id]/status
//
// Seeds 1 restaurant + owner/manager/staff/customer, places one order per
// scenario, forges cookies for each role, then verifies:
//   - owner can confirm    (pending    → confirmed)
//   - manager can prepare  (confirmed  → preparing)
//   - staff can mark ready (preparing  → ready)
//   - staff can deliver    (ready      → delivered)    — migration-dependent
//   - owner can cancel     (pending    → cancelled)
//   - staff CANNOT confirm (403)
//   - staff CANNOT cancel  (403)
//   - outsider session      (403)
//   - unauthenticated       (401)
//   - invalid transition   (409) — e.g. delivered → preparing
//   - audit rows written for each successful transition
//
// The 'delivered' branch is marked migration-dependent: if
// supabase-orders-delivered-status.sql hasn't been applied, the route
// returns 500 with a clear hint; we surface that case without failing.

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

const OWNER_PHONE    = '+999000444001'
const MANAGER_PHONE  = '+999000444002'
const STAFF_PHONE    = '+999000444003'
const OUTSIDER_PHONE = '+999000444004'
const CUSTOMER_PHONE = '+999000444005'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

function cookieFor(user: { id: string; phone: string; name: string }): string {
  const token = jwt.sign({ id: user.id, phone: user.phone, name: user.name, role: 'customer' }, JWT_SECRET, { expiresIn: '1h' })
  return `sm_session=${token}`
}

const seeded: Record<string, string> = {}
let restaurantId = ''

async function insertCustomer(phone: string, name: string): Promise<string> {
  const { data } = await sb.from('customers').insert({
    phone, name, city: 'Yaoundé', status: 'active',
  }).select('id').single()
  return data!.id
}

async function seed() {
  await sb.from('customers').delete().in('phone', [OWNER_PHONE, MANAGER_PHONE, STAFF_PHONE, OUTSIDER_PHONE, CUSTOMER_PHONE])

  seeded.owner    = await insertCustomer(OWNER_PHONE,    'Owner')
  seeded.manager  = await insertCustomer(MANAGER_PHONE,  'Manager')
  seeded.staff    = await insertCustomer(STAFF_PHONE,    'Staff')
  seeded.outsider = await insertCustomer(OUTSIDER_PHONE, 'Outsider')
  seeded.customer = await insertCustomer(CUSTOMER_PHONE, 'Customer')

  const { data: rest } = await sb.from('restaurants').insert({
    name: '__test_vendor_actions__', city: 'Yaoundé', neighborhood: 'Bastos',
    cuisine_type: 'Camerounaise', whatsapp: OWNER_PHONE,
    customer_id: seeded.owner, is_active: true, status: 'active', lat: 0, lng: 0,
  }).select('id').single()
  restaurantId = rest!.id

  // A DB trigger auto-adds the restaurants.customer_id as an 'owner' row.
  // Use upsert on the composite unique key so the manager/staff rows land
  // without the owner duplicate aborting the batch.
  await sb.from('restaurant_team').upsert([
    { restaurant_id: restaurantId, customer_id: seeded.owner,   role: 'owner',   status: 'active' },
    { restaurant_id: restaurantId, customer_id: seeded.manager, role: 'manager', status: 'active' },
    { restaurant_id: restaurantId, customer_id: seeded.staff,   role: 'staff',   status: 'active' },
  ], { onConflict: 'restaurant_id,customer_id' })
}

async function cleanup() {
  if (restaurantId) {
    const { data: ords } = await sb.from('orders').select('id').eq('restaurant_id', restaurantId)
    for (const o of ords ?? []) await sb.from('order_items').delete().eq('order_id', o.id)
    await sb.from('orders').delete().eq('restaurant_id', restaurantId)
    await sb.from('restaurant_team').delete().eq('restaurant_id', restaurantId)
    await sb.from('restaurants').delete().eq('id', restaurantId)
  }
  await sb.from('customers').delete().in('phone', [OWNER_PHONE, MANAGER_PHONE, STAFF_PHONE, OUTSIDER_PHONE, CUSTOMER_PHONE])
}

async function newOrder(status: string = 'pending'): Promise<string> {
  const { data } = await sb.from('orders').insert({
    restaurant_id: restaurantId,
    customer_id: seeded.customer,
    customer_name: 'Customer',
    customer_phone: CUSTOMER_PHONE,
    items: [{ name: 'Ndolé', quantity: 1, price: 2500 }],
    total_price: 2500,
    status,
  }).select('id').single()
  return data!.id
}

async function call(orderId: string, status: string, cookie: string | null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`${BASE}/api/orders/${orderId}/status`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status }),
  })
  return { status: res.status, body: await res.json() }
}

async function main() {
  await seed()
  const ownerCookie    = cookieFor({ id: seeded.owner,    phone: OWNER_PHONE,    name: 'Owner' })
  const managerCookie  = cookieFor({ id: seeded.manager,  phone: MANAGER_PHONE,  name: 'Manager' })
  const staffCookie    = cookieFor({ id: seeded.staff,    phone: STAFF_PHONE,    name: 'Staff' })
  const outsiderCookie = cookieFor({ id: seeded.outsider, phone: OUTSIDER_PHONE, name: 'Outsider' })

  try {
    console.log('\n1. Owner confirms a pending order')
    const o1 = await newOrder('pending')
    const r1 = await call(o1, 'confirmed', ownerCookie)
    assert(r1.status === 200, `HTTP 200 (got ${r1.status}: ${JSON.stringify(r1.body)})`)
    assert(r1.body.status === 'confirmed', 'new status = confirmed')
    assert(r1.body.previousStatus === 'pending', 'previousStatus = pending')

    console.log('\n2. Manager moves confirmed → preparing')
    const o2 = await newOrder('confirmed')
    const r2 = await call(o2, 'preparing', managerCookie)
    assert(r2.status === 200, `HTTP 200 (got ${r2.status}: ${JSON.stringify(r2.body)})`)
    assert(r2.body.status === 'preparing', 'preparing')

    console.log('\n3. Staff moves preparing → ready')
    const o3 = await newOrder('preparing')
    const r3 = await call(o3, 'ready', staffCookie)
    assert(r3.status === 200, `HTTP 200 (got ${r3.status}: ${JSON.stringify(r3.body)})`)
    assert(r3.body.status === 'ready', 'ready')

    console.log('\n4. Staff cannot confirm (403)')
    const o4 = await newOrder('pending')
    const r4 = await call(o4, 'confirmed', staffCookie)
    assert(r4.status === 403, `HTTP 403 (got ${r4.status})`)

    console.log('\n5. Staff cannot cancel (403)')
    const o5 = await newOrder('pending')
    const r5 = await call(o5, 'cancelled', staffCookie)
    assert(r5.status === 403, `HTTP 403 (got ${r5.status})`)

    console.log('\n6. Owner cancels a pending order')
    const o6 = await newOrder('pending')
    const r6 = await call(o6, 'cancelled', ownerCookie)
    assert(r6.status === 200, 'HTTP 200')
    assert(r6.body.status === 'cancelled', 'cancelled')

    console.log('\n7. Outsider session → 403')
    const o7 = await newOrder('pending')
    const r7 = await call(o7, 'confirmed', outsiderCookie)
    assert(r7.status === 403, `HTTP 403 (got ${r7.status})`)

    console.log('\n8. No cookie → 401')
    const o8 = await newOrder('pending')
    const r8 = await call(o8, 'confirmed', null)
    assert(r8.status === 401, `HTTP 401 (got ${r8.status})`)

    console.log('\n9. Invalid transition (cancelled → preparing) → 409')
    const o9 = await newOrder('cancelled')
    const r9 = await call(o9, 'preparing', ownerCookie)
    assert(r9.status === 409, `HTTP 409 (got ${r9.status})`)

    console.log('\n10. Unknown target status → 400')
    const o10 = await newOrder('pending')
    const r10 = await call(o10, 'nonsense', ownerCookie)
    assert(r10.status === 400, `HTTP 400 (got ${r10.status})`)

    console.log('\n11. Ready → delivered (migration-dependent)')
    const o11 = await newOrder('ready')
    const r11 = await call(o11, 'delivered', staffCookie)
    if (r11.status === 200) {
      assert(r11.body.status === 'delivered', 'delivered')
    } else if (r11.status === 500 && /migration/i.test(r11.body.error ?? '')) {
      console.log('  ⚠ delivered blocked by pre-migration constraint — expected if SQL not applied')
    } else {
      throw new Error(`unexpected delivered response: ${r11.status} ${JSON.stringify(r11.body)}`)
    }

    console.log('\n12. Audit rows written')
    const { data: audits } = await sb.from('audit_log')
      .select('action, target_id')
      .in('action', ['order_confirmed', 'order_preparing', 'order_ready', 'order_cancelled'])
      .in('target_id', [o1, o2, o3, o6])
    const actions = new Set((audits ?? []).map(a => a.action))
    assert(actions.has('order_confirmed'), 'order_confirmed audit row')
    assert(actions.has('order_preparing'), 'order_preparing audit row')
    assert(actions.has('order_ready'),     'order_ready audit row')
    assert(actions.has('order_cancelled'), 'order_cancelled audit row')

    console.log('\n✓ ALL VENDOR-ACTION ASSERTIONS PASSED')
  } finally {
    await cleanup()
  }
}

main().catch(e => { console.error(e); cleanup().finally(() => process.exit(1)) })
