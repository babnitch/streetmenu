// E2E test for the restaurant-approval welcome WhatsApp.
// Seeds a pending restaurant + owner team row, hits POST /approve with a
// forged admin session cookie, then:
//   - confirms the DB went from status='pending' to 'active'
//   - confirms restaurant_approved audit_log entry landed
//   - confirms the ok=true + welcomedOwners=true response
// Reruns the approve call to confirm idempotency: second call returns
// welcomedOwners=false so the welcome is not spammed.
//
// Twilio sends will 401 locally with dummy creds — the point of this test is
// to verify the RECIPIENT list computation and the no-spam rule, which are
// the parts that were not obvious by reading the code.

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

const OWNER_PHONE = '+999000777555'  // fake — sandbox sends will 401/fail, fine

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

// Locate a super_admin to forge a session with
async function findAdmin(): Promise<{ id: string; email: string; name: string; role: string }> {
  const { data } = await sb.from('admin_users').select('id, email, name, role').eq('role', 'super_admin').limit(1).maybeSingle()
  if (!data) throw new Error('no super_admin in DB — seed one first')
  return data
}

function adminCookie(admin: { id: string; email: string; name: string; role: string }): string {
  const token = jwt.sign({ id: admin.id, email: admin.email, name: admin.name, role: admin.role }, JWT_SECRET, { expiresIn: '1h' })
  return `sm_session=${token}`
}

async function callApprove(restaurantId: string, cookie: string) {
  const res = await fetch(`${BASE}/api/restaurants/${restaurantId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
  })
  return { status: res.status, body: await res.json() }
}

let ownerCustomerId = ''
let restaurantId = ''

async function seed() {
  await sb.from('customers').delete().eq('phone', OWNER_PHONE)

  const { data: cust, error: custErr } = await sb.from('customers').insert({
    phone: OWNER_PHONE, name: 'Test Owner', city: 'Yaoundé', status: 'active',
  }).select('id').single()
  if (custErr || !cust) throw new Error('seed customer failed: ' + custErr?.message)
  ownerCustomerId = cust.id

  const { data: rest, error: restErr } = await sb.from('restaurants').insert({
    name: '__test_approve_welcome__',
    city: 'Yaoundé', neighborhood: 'Bastos', cuisine_type: 'Camerounaise',
    whatsapp: OWNER_PHONE,
    customer_id: ownerCustomerId,
    status: 'pending',
    is_active: false,
    lat: 0, lng: 0,
  }).select('id').single()
  if (restErr || !rest) throw new Error('seed restaurant failed: ' + restErr?.message)
  restaurantId = rest.id

  // Also register the owner in restaurant_team (many deploys do this after
  // vendor signup completes; include here to exercise the full fan-out path)
  await sb.from('restaurant_team').insert({
    restaurant_id: restaurantId, customer_id: ownerCustomerId, role: 'owner', status: 'active',
  })
}

async function cleanup() {
  if (restaurantId) {
    await sb.from('restaurant_team').delete().eq('restaurant_id', restaurantId)
    await sb.from('restaurants').delete().eq('id', restaurantId)
  }
  if (ownerCustomerId) {
    await sb.from('customers').delete().eq('id', ownerCustomerId)
  }
}

async function latestApprovalAudit(): Promise<{ action: string; target_id: string; previous_data: unknown } | null> {
  const { data } = await sb.from('audit_log').select('action, target_id, previous_data')
    .eq('target_id', restaurantId).eq('action', 'restaurant_approved')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  return data as { action: string; target_id: string; previous_data: unknown } | null
}

async function currentStatus(): Promise<string | null> {
  const { data } = await sb.from('restaurants').select('status').eq('id', restaurantId).maybeSingle()
  return data?.status ?? null
}

async function main() {
  console.log('Seeding…')
  await seed()
  const admin = await findAdmin()
  console.log(`  admin=${admin.email} (${admin.role})`)
  console.log(`  restaurant=${restaurantId.slice(0, 8)}  owner=${ownerCustomerId.slice(0, 8)}  phone=${OWNER_PHONE}`)
  const cookie = adminCookie(admin)

  try {
    console.log('\n1. First approve — pending → active, welcome should be sent')
    const r1 = await callApprove(restaurantId, cookie)
    assert(r1.status === 200, `HTTP 200 (got ${r1.status})`)
    assert(r1.body.ok === true, 'ok=true')
    assert(r1.body.welcomedOwners === true, 'welcomedOwners=true on the transition')

    const statusAfter1 = await currentStatus()
    assert(statusAfter1 === 'active', `restaurants.status = 'active' (got ${statusAfter1})`)

    const audit1 = await latestApprovalAudit()
    assert(!!audit1, 'restaurant_approved audit row exists')
    const prev = (audit1!.previous_data as { status?: string } | null)?.status
    assert(prev === 'pending', `audit previous_data.status = 'pending' (got ${prev})`)

    console.log('\n2. Second approve — already active, welcome should NOT be sent')
    const r2 = await callApprove(restaurantId, cookie)
    assert(r2.status === 200, `HTTP 200 (got ${r2.status})`)
    assert(r2.body.ok === true, 'ok=true')
    assert(r2.body.welcomedOwners === false, 'welcomedOwners=false on re-approval (no-spam)')

    console.log('\n3. Auth: missing session returns 401')
    const r3 = await fetch(`${BASE}/api/restaurants/${restaurantId}/approve`, { method: 'POST' })
    assert(r3.status === 401, `HTTP 401 for unauthenticated (got ${r3.status})`)

    console.log('\n✓ ALL APPROVE-WELCOME ASSERTIONS PASSED')
  } finally {
    await cleanup()
  }
}

main().catch(e => { console.error(e); cleanup().finally(() => process.exit(1)) })
