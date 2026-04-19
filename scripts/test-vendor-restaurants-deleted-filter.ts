// E2E for: GET /api/vendor/restaurants must never include soft-deleted rows,
// even when the session still has a restaurant_team row pointing at one or
// owns it directly via customer_id.

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

const OWNER_PHONE = '+999000777012'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}
function cookieFor(u: { id: string; phone: string; name: string }): string {
  return 'sm_session=' + jwt.sign({ id: u.id, phone: u.phone, name: u.name, role: 'customer' }, JWT_SECRET, { expiresIn: '1h' })
}

let ownerId = '', aliveId = '', deletedById = '', deletedByStatusId = ''

async function seed() {
  await sb.from('customers').delete().eq('phone', OWNER_PHONE)
  const { data: owner } = await sb.from('customers').insert({
    phone: OWNER_PHONE, name: 'Multi Owner', city: 'Yaoundé', status: 'active',
  }).select('id').single()
  ownerId = owner!.id

  const mk = async (name: string, overrides: Record<string, unknown>) => {
    const { data } = await sb.from('restaurants').insert({
      name, city: 'Yaoundé', neighborhood: 'Bastos', cuisine_type: 'Camerounaise',
      whatsapp: OWNER_PHONE, customer_id: ownerId, is_active: true, status: 'active',
      lat: 0, lng: 0, ...overrides,
    }).select('id').single()
    return data!.id
  }

  aliveId             = await mk('__probe_alive__',      {})
  deletedById         = await mk('__probe_deleted_by__', { deleted_at: new Date().toISOString() })
  deletedByStatusId   = await mk('__probe_status_del__', { status: 'deleted' })
}

async function cleanup() {
  for (const id of [aliveId, deletedById, deletedByStatusId]) {
    if (!id) continue
    await sb.from('restaurant_team').delete().eq('restaurant_id', id)
    await sb.from('restaurants').delete().eq('id', id)
  }
  await sb.from('customers').delete().eq('phone', OWNER_PHONE)
}

async function main() {
  await seed()
  const cookie = cookieFor({ id: ownerId, phone: OWNER_PHONE, name: 'Multi Owner' })
  try {
    const res = await fetch(`${BASE}/api/vendor/restaurants`, { headers: { Cookie: cookie } })
    const body = await res.json()
    assert(res.status === 200, 'HTTP 200')
    const ids = (body.restaurants ?? []).map((r: { id: string }) => r.id)
    assert(ids.includes(aliveId), 'alive restaurant included')
    assert(!ids.includes(deletedById), 'deleted_at=not-null excluded')
    assert(!ids.includes(deletedByStatusId), "status='deleted' excluded")
    assert(body.rolesByRestaurantId?.[aliveId] === 'owner', 'alive has role=owner')
    assert(body.rolesByRestaurantId?.[deletedById] === undefined, 'deleted row has no role entry')
    assert(body.rolesByRestaurantId?.[deletedByStatusId] === undefined, 'status-deleted row has no role entry')
    console.log('\n✓ DELETED FILTER PASSED')
  } finally {
    await cleanup()
  }
}

main().catch(e => { console.error(e); cleanup().finally(() => process.exit(1)) })
