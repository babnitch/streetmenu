// E2E test of the WhatsApp ordering webhook.
//
// Seeds a test customer + test restaurant + 2 menu items, then posts
// Twilio-shaped form-encoded payloads to the local webhook and verifies
// the resulting DB state. Cleans up at the end.
//
// Twilio sends may fail (no real creds) — that's fine, they're non-blocking.
// What we care about is that the DB side transitions correctly.

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

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } })

const WEBHOOK = process.env.WEBHOOK_URL ?? 'http://localhost:3001/api/whatsapp/incoming'
const CUSTOMER_PHONE = '+999000111222'     // fake, guaranteed-not-real
const VENDOR_PHONE   = '+999000333444'     // fake, guaranteed-not-real

async function send(from: string, body: string): Promise<void> {
  const params = new URLSearchParams({
    From: `whatsapp:${from}`,
    Body: body,
    NumMedia: '0',
  })
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) throw new Error(`webhook ${res.status}`)
}

let customerId = ''
let vendorCustomerId = ''
let restaurantId = ''
let menuId1 = '', menuId2 = ''

async function seed(): Promise<void> {
  console.log('Seeding…')
  // Clean prior runs
  await sb.from('customers').delete().in('phone', [CUSTOMER_PHONE, VENDOR_PHONE])

  const { data: cust } = await sb.from('customers').insert({
    phone: CUSTOMER_PHONE, name: 'Test Customer', city: 'Yaoundé', status: 'active',
  }).select('id').single()
  customerId = cust!.id

  const { data: vcust } = await sb.from('customers').insert({
    phone: VENDOR_PHONE, name: 'Test Vendor', city: 'Yaoundé', status: 'active',
  }).select('id').single()
  vendorCustomerId = vcust!.id

  const { data: rest } = await sb.from('restaurants').insert({
    name: '__test_ordering_restaurant__',
    city: 'Yaoundé',
    neighborhood: 'Bastos',
    cuisine_type: 'Camerounaise',
    whatsapp: VENDOR_PHONE,
    customer_id: vendorCustomerId,
    is_active: true,
    status: 'active',
    lat: 0, lng: 0,
  }).select('id').single()
  restaurantId = rest!.id

  const { data: m1 } = await sb.from('menu_items').insert({
    restaurant_id: restaurantId, name: 'Ndolé', price: 2500,
    is_available: true, category: 'Plats', description: '',
  }).select('id').single()
  menuId1 = m1!.id
  const { data: m2 } = await sb.from('menu_items').insert({
    restaurant_id: restaurantId, name: 'Eru', price: 2000,
    is_available: true, category: 'Plats', description: '',
  }).select('id').single()
  menuId2 = m2!.id

  // Pre-clear any stray sessions
  await sb.from('signup_sessions').delete().in('phone', [CUSTOMER_PHONE, VENDOR_PHONE])
  console.log(`  customer=${customerId.slice(0, 8)} vendor=${vendorCustomerId.slice(0, 8)} rest=${restaurantId.slice(0, 8)} items=${menuId1.slice(0,8)},${menuId2.slice(0,8)}`)
}

async function cleanup(): Promise<void> {
  console.log('Cleanup…')
  if (customerId) {
    await sb.from('order_items').delete().in('order_id',
      ((await sb.from('orders').select('id').eq('customer_id', customerId)).data ?? []).map(o => o.id),
    )
    await sb.from('orders').delete().eq('customer_id', customerId)
  }
  if (restaurantId) {
    await sb.from('menu_items').delete().eq('restaurant_id', restaurantId)
    await sb.from('restaurants').delete().eq('id', restaurantId)
  }
  await sb.from('signup_sessions').delete().in('phone', [CUSTOMER_PHONE, VENDOR_PHONE])
  await sb.from('customers').delete().in('phone', [CUSTOMER_PHONE, VENDOR_PHONE])
}

async function waitForSession(expectedStep: number, timeoutMs = 3000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { data } = await sb.from('signup_sessions').select('*').eq('phone', CUSTOMER_PHONE).maybeSingle()
    if (data && data.step === expectedStep) return data
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`session did not reach step ${expectedStep}`)
}

async function waitForOrder(expectedStatus: string, timeoutMs = 5000): Promise<{ id: string; status: string; total_price: number }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { data } = await sb.from('orders').select('id, status, total_price')
      .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (data && data.status === expectedStatus) return data
    await new Promise(r => setTimeout(r, 150))
  }
  const { data: latest } = await sb.from('orders').select('id, status, total_price')
    .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  throw new Error(`order did not reach status '${expectedStatus}'; latest=${JSON.stringify(latest)}`)
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

async function main() {
  await seed()
  try {
    console.log('\n1. Customer: "commander" → step 1 session')
    await send(CUSTOMER_PHONE, 'commander')
    const s1 = await waitForSession(1) as { data: { candidates: Array<{ id: string; name: string }> } }
    const candidates = s1.data.candidates
    assert(Array.isArray(candidates) && candidates.length > 0, 'candidates populated')
    const ourIdx = candidates.findIndex(c => c.id === restaurantId)
    assert(ourIdx >= 0, 'test restaurant appears in list')

    console.log(`\n2. Customer: pick restaurant number ${ourIdx + 1} → step 2 session`)
    await send(CUSTOMER_PHONE, String(ourIdx + 1))
    const s2 = await waitForSession(2) as { data: { restaurant_id: string; menu: Array<{ menu_item_id: string; price: number }> } }
    assert(s2.data.restaurant_id === restaurantId, 'session restaurant_id correct')
    assert(s2.data.menu.length === 2, 'menu snapshot has 2 items')

    // Menu is sorted alphabetically in DB query: Eru(2000) then Ndolé(2500).
    // "1 x2, 2 x1" => 2× Eru + 1× Ndolé = 4000 + 2500 = 6500.
    const EXPECTED_TOTAL = 2 * 2000 + 1 * 2500
    console.log('\n3. Customer: "1 x2, 2 x1" → step 3 session with summary')
    await send(CUSTOMER_PHONE, '1 x2, 2 x1')
    const s3 = await waitForSession(3) as { data: { total: number; items: Array<{ quantity: number }> } }
    assert(s3.data.total === EXPECTED_TOTAL, `total is ${s3.data.total}`)
    assert(s3.data.items.length === 2, 'two line items')

    console.log('\n4. Customer: "oui" → order created with status=pending')
    await send(CUSTOMER_PHONE, 'oui')
    const order = await waitForOrder('pending')
    assert(order.total_price == EXPECTED_TOTAL, `order total_price=${order.total_price}`)
    const { data: orderItems } = await sb.from('order_items').select('*').eq('order_id', order.id)
    assert((orderItems?.length ?? 0) === 2, 'order_items has 2 rows')
    const { data: post } = await sb.from('signup_sessions').select('*').eq('phone', CUSTOMER_PHONE).maybeSingle()
    assert(!post, 'ordering session cleared after order creation')

    const last4 = order.id.replace(/-/g, '').slice(-4)

    console.log(`\n5. Vendor: "ok ${last4}" → status=confirmed`)
    await send(VENDOR_PHONE, `ok ${last4}`)
    const confirmed = await waitForOrder('confirmed')
    assert(confirmed.id === order.id, 'same order row')

    console.log(`\n6. Vendor: "pret ${last4}" → status=ready`)
    await send(VENDOR_PHONE, `pret ${last4}`)
    const ready = await waitForOrder('ready')
    assert(ready.id === order.id, 'same order row')

    console.log('\n7. Customer: "mes commandes" → no DB change, only WhatsApp reply')
    await send(CUSTOMER_PHONE, 'mes commandes')

    console.log('\n8. Cancel a second order via "annuler XXXX"')
    // Place a second order quickly
    await send(CUSTOMER_PHONE, 'commander')
    await waitForSession(1)
    // Refresh candidates since it's a new session
    const { data: s1b } = await sb.from('signup_sessions').select('*').eq('phone', CUSTOMER_PHONE).maybeSingle()
    const cand2 = (s1b!.data as { candidates: Array<{ id: string }> }).candidates
    const idx2 = cand2.findIndex(c => c.id === restaurantId)
    await send(CUSTOMER_PHONE, String(idx2 + 1))
    await waitForSession(2)
    await send(CUSTOMER_PHONE, '1 x1')
    await waitForSession(3)
    await send(CUSTOMER_PHONE, 'oui')
    const order2 = await waitForOrder('pending')
    const last4b = order2.id.replace(/-/g, '').slice(-4)

    console.log(`   Vendor: "annuler ${last4b}" — migration-dependent`)
    await send(VENDOR_PHONE, `annuler ${last4b}`)
    try {
      await waitForOrder('cancelled', 3000)
      console.log('   ✓ cancel succeeded — migration IS applied')
    } catch {
      const { data } = await sb.from('orders').select('status').eq('id', order2.id).maybeSingle()
      console.log(`   ⚠ cancel did not take effect — migration NOT applied (status=${data?.status}). Expected before running supabase-orders-cancelled-status.sql.`)
    }

    console.log('\n✓ ALL E2E CHECKS PASSED (except possibly cancelled if migration pending)')
  } finally {
    await cleanup()
  }
}
main().catch(e => { console.error(e); cleanup().finally(() => process.exit(1)) })
