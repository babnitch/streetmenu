// E2E for:
//   1. GET /api/vendor/restaurants returns restaurants sourced from both
//      restaurant_team AND restaurants.customer_id (legacy/implicit owners).
//   2. POST /api/orders/[id]/status accepts a legacy owner (no team row,
//      just restaurants.customer_id) as effective owner.
//
// Reproduces the MeResto bug exactly: a restaurant exists with
// customer_id set and an active owner team row is either absent (legacy)
// or present. The dashboard must see the restaurant in both cases, and
// the status route must allow the owner's actions in both cases.

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

const LEGACY_OWNER_PHONE = '+999000888111'  // becomes owner via customer_id only
const CUSTOMER_PHONE     = '+999000888222'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}
function cookieFor(u: { id: string; phone: string; name: string }): string {
  const token = jwt.sign({ id: u.id, phone: u.phone, name: u.name, role: 'customer' }, JWT_SECRET, { expiresIn: '1h' })
  return `sm_session=${token}`
}

let ownerId = '', customerId = '', restaurantId = '', orderId = ''

async function seed() {
  await sb.from('customers').delete().in('phone', [LEGACY_OWNER_PHONE, CUSTOMER_PHONE])

  const { data: ownerRow } = await sb.from('customers').insert({
    phone: LEGACY_OWNER_PHONE, name: 'Legacy Owner', city: 'Yaoundé', status: 'active',
  }).select('id').single()
  ownerId = ownerRow!.id

  const { data: custRow } = await sb.from('customers').insert({
    phone: CUSTOMER_PHONE, name: 'Paying Customer', city: 'Yaoundé', status: 'active',
  }).select('id').single()
  customerId = custRow!.id

  const { data: rest } = await sb.from('restaurants').insert({
    name: '__test_legacy_owner__', city: 'Yaoundé', neighborhood: 'Bastos',
    cuisine_type: 'Camerounaise', whatsapp: LEGACY_OWNER_PHONE,
    customer_id: ownerId, is_active: true, status: 'active', lat: 0, lng: 0,
  }).select('id').single()
  restaurantId = rest!.id

  // Simulate the legacy state: no explicit restaurant_team row. If the DB
  // trigger auto-inserted one, delete it so the test exercises the fallback.
  await sb.from('restaurant_team').delete().eq('restaurant_id', restaurantId)

  const { data: ord } = await sb.from('orders').insert({
    restaurant_id: restaurantId, customer_id: customerId,
    customer_name: 'Paying Customer', customer_phone: CUSTOMER_PHONE,
    items: [{ name: 'Ndolé', quantity: 1, price: 2500 }],
    total_price: 2500, status: 'pending',
  }).select('id').single()
  orderId = ord!.id
}

async function cleanup() {
  if (restaurantId) {
    await sb.from('order_items').delete().eq('order_id', orderId)
    await sb.from('orders').delete().eq('restaurant_id', restaurantId)
    await sb.from('restaurant_team').delete().eq('restaurant_id', restaurantId)
    await sb.from('restaurants').delete().eq('id', restaurantId)
  }
  await sb.from('customers').delete().in('phone', [LEGACY_OWNER_PHONE, CUSTOMER_PHONE])
}

async function main() {
  await seed()
  const ownerCookie = cookieFor({ id: ownerId, phone: LEGACY_OWNER_PHONE, name: 'Legacy Owner' })

  try {
    // Sanity: team row genuinely absent (simulating legacy data)
    const { data: teamRows } = await sb.from('restaurant_team').select('*').eq('restaurant_id', restaurantId)
    assert((teamRows ?? []).length === 0, 'pre-condition: no restaurant_team row for this restaurant')

    console.log('\n1. GET /api/vendor/restaurants includes the legacy-owned restaurant')
    const listRes = await fetch(`${BASE}/api/vendor/restaurants`, { headers: { Cookie: ownerCookie } })
    const listBody = await listRes.json()
    assert(listRes.status === 200, `HTTP 200 (got ${listRes.status})`)
    const match = (listBody.restaurants ?? []).find((r: { id: string }) => r.id === restaurantId)
    assert(!!match, 'restaurant appears in list via customer_id fallback')
    assert(match.teamRole === 'owner', 'teamRole=owner for the implicit-owner fallback')
    const roleMap = listBody.rolesByRestaurantId ?? {}
    assert(roleMap[restaurantId] === 'owner', 'rolesByRestaurantId has owner for this restaurant')

    console.log('\n2. POST /api/orders/[id]/status accepts the legacy owner for pending → confirmed')
    const r1 = await fetch(`${BASE}/api/orders/${orderId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ status: 'confirmed' }),
    })
    const b1 = await r1.json()
    assert(r1.status === 200, `HTTP 200 (got ${r1.status}: ${JSON.stringify(b1)})`)
    assert(b1.status === 'confirmed', 'status=confirmed')

    console.log('\n3. Legacy owner can cancel (role-gated action)')
    const r2 = await fetch(`${BASE}/api/orders/${orderId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ status: 'cancelled' }),
    })
    assert(r2.status === 200, `HTTP 200 (got ${r2.status})`)

    console.log('\n4. Audit row records role=owner for the legacy transition')
    const { data: audits } = await sb.from('audit_log')
      .select('action, performed_by, previous_data')
      .eq('target_id', orderId).eq('action', 'order_confirmed').limit(1).maybeSingle()
    assert(!!audits, 'audit row exists')
    const prev = audits!.previous_data as { role?: string } | null
    assert(prev?.role === 'owner', `previous_data.role=owner (got ${prev?.role})`)

    console.log('\n✓ ALL LEGACY-OWNER ASSERTIONS PASSED')
  } finally {
    await cleanup()
  }
}

main().catch(e => { console.error(e); cleanup().finally(() => process.exit(1)) })
