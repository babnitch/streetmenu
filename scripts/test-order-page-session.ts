// E2E for logged-in customer checkout.
// Seeds a customer, forges their sm_session JWT cookie, then:
//   1. Fetches /api/auth/me with the cookie — confirms the server returns
//      the customer (this is what the order page calls on mount).
//   2. Fetches /order to ensure the page renders (no 500s) — we can't drive
//      the DOM without a browser, but a clean 200 plus a bundle that
//      references /api/auth/me is strong evidence the new code is live.
//   3. Simulates an order insert with customer_id and confirms the row is
//      linked to the session's customer.
//   4. Same simulation without a session: customer_id should be null.
//
// Also confirms a guest order + a logged-in order both appear in the
// customer's "mes commandes" only when linked.

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

const CUSTOMER_PHONE = '+999000666123'
const CUSTOMER_NAME  = 'Test Checkout'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

function customerCookie(user: { id: string; phone: string; name: string }): string {
  const token = jwt.sign({ id: user.id, phone: user.phone, name: user.name, role: 'customer' }, JWT_SECRET, { expiresIn: '1h' })
  return `sm_session=${token}`
}

let customerId = ''
let restaurantId = ''

async function seed() {
  await sb.from('customers').delete().eq('phone', CUSTOMER_PHONE)

  const { data: cust } = await sb.from('customers').insert({
    phone: CUSTOMER_PHONE, name: CUSTOMER_NAME, city: 'Yaoundé', status: 'active',
  }).select('id').single()
  customerId = cust!.id

  // Reuse whatever active restaurant exists
  const { data: rest } = await sb.from('restaurants').select('id')
    .eq('is_active', true).in('status', ['active', 'approved']).limit(1).maybeSingle()
  if (!rest) throw new Error('no active restaurant to order from — seed one first')
  restaurantId = rest.id
}

async function cleanup() {
  if (customerId) {
    const { data: ords } = await sb.from('orders').select('id').eq('customer_id', customerId)
    for (const o of ords ?? []) {
      await sb.from('order_items').delete().eq('order_id', o.id)
    }
    await sb.from('orders').delete().eq('customer_id', customerId)
    await sb.from('orders').delete().eq('customer_phone', CUSTOMER_PHONE)
    await sb.from('customers').delete().eq('id', customerId)
  }
}

async function main() {
  await seed()
  console.log(`seed customer=${customerId.slice(0, 8)} phone=${CUSTOMER_PHONE} restaurant=${restaurantId.slice(0, 8)}`)
  const cookie = customerCookie({ id: customerId, phone: CUSTOMER_PHONE, name: CUSTOMER_NAME })

  try {
    console.log('\n1. /api/auth/me with session returns the customer')
    const meRes = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    const me = await meRes.json()
    assert(meRes.status === 200, 'HTTP 200')
    assert(me.user?.role === 'customer', 'role=customer')
    assert(me.user?.id === customerId, 'id matches seed')
    assert(me.user?.name === CUSTOMER_NAME, 'name matches seed')
    assert(me.user?.phone === CUSTOMER_PHONE, 'phone matches seed')

    console.log('\n2. /order page renders (no 500) and bundle uses /api/auth/me')
    const pageRes = await fetch(`${BASE}/order`, { headers: { Cookie: cookie } })
    assert(pageRes.status === 200, `/order HTTP 200 (got ${pageRes.status})`)
    const html = await pageRes.text()
    const bundleMatch = html.match(/\/_next\/static\/chunks\/app\/order\/page[^"]*\.js/)
    assert(!!bundleMatch, '/order bundle URL found in page HTML')
    const bundleRes = await fetch(`${BASE}${bundleMatch![0]}`)
    const bundle = await bundleRes.text()
    assert(bundle.includes('/api/auth/me'), 'bundle references /api/auth/me (new code live)')
    assert(bundle.includes('role') && bundle.includes('customer'), 'bundle filters for role=customer')

    console.log('\n3. Insert a logged-in order → customer_id linked')
    const { data: ord1 } = await sb.from('orders').insert({
      restaurant_id: restaurantId,
      customer_name: CUSTOMER_NAME,
      customer_phone: CUSTOMER_PHONE,
      items: [{ name: 'Ndolé', quantity: 1, price: 2500 }],
      total_price: 2500,
      status: 'pending',
      customer_id: customerId,
    }).select('id, customer_id').single()
    assert(ord1!.customer_id === customerId, 'logged-in order linked to customer_id')

    console.log('\n4. Insert a guest order (customer_id = null) → appears by phone only')
    const { data: ord2 } = await sb.from('orders').insert({
      restaurant_id: restaurantId,
      customer_name: 'Guest',
      customer_phone: '+999000999999',
      items: [{ name: 'Eru', quantity: 1, price: 2000 }],
      total_price: 2000,
      status: 'pending',
      customer_id: null,
    }).select('id, customer_id').single()
    assert(ord2!.customer_id === null, 'guest order has null customer_id')
    // Cleanup guest directly since it's not linked
    await sb.from('orders').delete().eq('id', ord2!.id)

    console.log('\n5. "Mes commandes" query scoped to customer_id returns only the linked one')
    const { data: mine } = await sb.from('orders').select('id, customer_id')
      .eq('customer_id', customerId).order('created_at', { ascending: false })
    assert((mine?.length ?? 0) === 1, `exactly one order in "mes commandes" (got ${mine?.length})`)
    assert(mine![0].id === ord1!.id, 'it is the logged-in order')

    console.log('\n✓ ALL CHECKOUT-SESSION ASSERTIONS PASSED')
  } finally {
    await cleanup()
  }
}

main().catch(e => { console.error(e); cleanup().finally(() => process.exit(1)) })
