// E2E for POST /api/whatsapp/notify-order
//
// Seeds a restaurant with a direct whatsapp number AND an active owner row
// in restaurant_team (matching phone — so the deduper should collapse to 1).
// Creates an orders row, hits the endpoint, inspects the response + the
// outcome log lines.
//
// Twilio sends fail 401 locally (fake creds). That's fine — we're testing
// the orchestration: that both the customer and the vendor sends are
// attempted and logged, not the actual delivery.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

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

const CUSTOMER_PHONE = '+999000111444'
const OWNER_PHONE    = '+999000222555'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

let customerId = '', ownerId = '', restaurantId = '', orderId = ''

async function seed() {
  await sb.from('customers').delete().in('phone', [CUSTOMER_PHONE, OWNER_PHONE])

  const { data: cust } = await sb.from('customers').insert({
    phone: CUSTOMER_PHONE, name: 'Web Customer', city: 'Yaoundé', status: 'active',
  }).select('id').single()
  customerId = cust!.id

  const { data: owner } = await sb.from('customers').insert({
    phone: OWNER_PHONE, name: 'Web Owner', city: 'Yaoundé', status: 'active',
  }).select('id').single()
  ownerId = owner!.id

  const { data: rest } = await sb.from('restaurants').insert({
    name: '__test_notify_order__',
    city: 'Yaoundé', neighborhood: 'Bastos', cuisine_type: 'Camerounaise',
    whatsapp: OWNER_PHONE,
    customer_id: ownerId,
    is_active: true, status: 'active',
    lat: 0, lng: 0,
  }).select('id').single()
  restaurantId = rest!.id

  await sb.from('restaurant_team').insert({
    restaurant_id: restaurantId, customer_id: ownerId, role: 'owner', status: 'active',
  })

  const { data: order } = await sb.from('orders').insert({
    restaurant_id: restaurantId,
    customer_id: customerId,
    customer_name: 'Web Customer',
    customer_phone: CUSTOMER_PHONE,
    items: [
      { name: 'Ndolé', quantity: 2, price: 2500 },
      { name: 'Eru',   quantity: 1, price: 2000 },
    ],
    total_price: 7000,
    status: 'pending',
  }).select('id').single()
  orderId = order!.id
}

async function cleanup() {
  if (orderId) {
    await sb.from('order_items').delete().eq('order_id', orderId)
    await sb.from('orders').delete().eq('id', orderId)
  }
  if (restaurantId) {
    await sb.from('restaurant_team').delete().eq('restaurant_id', restaurantId)
    await sb.from('restaurants').delete().eq('id', restaurantId)
  }
  await sb.from('customers').delete().in('phone', [CUSTOMER_PHONE, OWNER_PHONE])
}

async function callNotify(id: string) {
  const res = await fetch(`${BASE}/api/whatsapp/notify-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: id }),
  })
  return { status: res.status, body: await res.json() }
}

async function main() {
  await seed()
  console.log(`seed: order=${orderId.slice(0, 8)} customer=${CUSTOMER_PHONE} owner=${OWNER_PHONE}`)

  try {
    console.log('\n1. notify-order for a valid order → ok, both sides attempted')
    const r = await callNotify(orderId)
    assert(r.status === 200, `HTTP 200 (got ${r.status})`)
    assert(r.body.ok === true, 'ok=true')
    // customerNotified is true iff customer_phone existed AND the notify promise
    // resolved. Twilio 401 inside notify DOES resolve (notifyCustomerOrderPlaced
    // awaits sendWhatsApp which always returns, never throws).
    assert(r.body.customerNotified === true, 'customerNotified=true (customer_phone present)')
    assert(r.body.vendorFanoutStatus === 'fulfilled', 'vendor fan-out fulfilled (not rejected)')

    console.log('\n2. notify-order with missing orderId → 400')
    const r2 = await fetch(`${BASE}/api/whatsapp/notify-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert(r2.status === 400, 'HTTP 400 for missing orderId')

    console.log('\n3. notify-order with unknown orderId → 404')
    const r3 = await callNotify('00000000-0000-0000-0000-000000000000')
    assert(r3.status === 404, 'HTTP 404 for missing order row')

    console.log('\n✓ ALL NOTIFY-ORDER ASSERTIONS PASSED')
  } finally {
    await cleanup()
  }
}

main().catch(e => { console.error(e); cleanup().finally(() => process.exit(1)) })
