// E2E test for the check-phone flow.
// Seeds a WhatsApp-style customer then confirms:
//   - check-phone finds them for all equivalent phone formats
//   - check-phone returns {exists:false} for an unknown phone
//   - send-code with just the phone succeeds for existing customer
//   - send-code with just the phone returns needsRegistration for unknown
//   - No duplicate customer rows are ever created

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

const KNOWN_PHONE   = '+999000555111'    // stored by "WhatsApp" seed
const KNOWN_NAME    = 'Test WA Customer'
const UNKNOWN_PHONE = '+999000888222'    // never inserted

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

async function seed() {
  await sb.from('customers').delete().in('phone', [KNOWN_PHONE, UNKNOWN_PHONE])
  const { error } = await sb.from('customers').insert({
    phone: KNOWN_PHONE, name: KNOWN_NAME, city: 'Yaoundé', status: 'active',
  })
  if (error) throw new Error('seed failed: ' + error.message)
}

async function cleanup() {
  await sb.from('verification_codes').delete().in('phone', [KNOWN_PHONE, UNKNOWN_PHONE])
  await sb.from('customers').delete().in('phone', [KNOWN_PHONE, UNKNOWN_PHONE])
}

async function checkPhone(raw: string) {
  const res = await fetch(`${BASE}/api/auth/check-phone?phone=${encodeURIComponent(raw)}`)
  return { status: res.status, body: await res.json() }
}

async function sendCode(phone: string, name?: string, city?: string) {
  const payload: Record<string, string> = { phone }
  if (name) payload.name = name
  if (city) payload.city = city
  const res = await fetch(`${BASE}/api/auth/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: await res.json() }
}

async function countCustomers(phone: string): Promise<number> {
  const { count } = await sb.from('customers')
    .select('*', { count: 'exact', head: true })
    .eq('phone', phone)
  return count ?? 0
}

async function main() {
  console.log('Seeding WhatsApp-style customer…')
  await seed()

  try {
    console.log('\n1. check-phone finds existing customer across formats')
    const variants = [
      KNOWN_PHONE,                  // exact
      '999000555111',               // missing +
      '+999 000 555 111',           // with spaces
      '+999-000-555-111',           // with dashes
      '  +999000555111  ',          // with surrounding whitespace
      '00999000555111',             // 00 international prefix (European convention)
      '00 999 000 555 111',         // 00 prefix with spaces
    ]
    for (const v of variants) {
      const r = await checkPhone(v)
      assert(r.status === 200, `${JSON.stringify(v)} → HTTP 200`)
      assert(r.body.exists === true, `${JSON.stringify(v)} → exists=true`)
      assert(r.body.name === KNOWN_NAME, `${JSON.stringify(v)} → name=${KNOWN_NAME}`)
      assert(r.body.normalizedPhone === KNOWN_PHONE, `${JSON.stringify(v)} → normalized=${KNOWN_PHONE}`)
    }

    console.log('\n2. check-phone returns exists:false for unknown phone')
    const r2 = await checkPhone(UNKNOWN_PHONE)
    assert(r2.status === 200, 'HTTP 200')
    assert(r2.body.exists === false, 'exists=false')
    assert(r2.body.name === null, 'name=null')

    console.log('\n3. check-phone rejects empty input')
    const r3 = await checkPhone('')
    assert(r3.status === 400, 'HTTP 400 for empty phone')

    console.log('\n4. send-code with phone-only for existing customer → sent:true')
    // Even if the client typed a messy version of the phone, send-code now
    // normalizes it the same way and finds the existing row.
    const r4 = await sendCode('+999 000 555 111')
    assert(r4.status === 200, 'HTTP 200')
    assert(r4.body.sent === true, 'sent=true')
    assert(r4.body.needsRegistration === undefined, 'no needsRegistration flag')
    assert((await countCustomers(KNOWN_PHONE)) === 1, 'still exactly 1 customer row (no dup)')

    console.log('\n5. send-code with phone-only for unknown customer → needsRegistration')
    const r5 = await sendCode(UNKNOWN_PHONE)
    assert(r5.status === 200, 'HTTP 200')
    assert(r5.body.needsRegistration === true, 'needsRegistration=true')
    assert((await countCustomers(UNKNOWN_PHONE)) === 0, 'no customer row created yet')

    console.log('\n6. Verification codes cleaned up per phone for the existing customer')
    const { data: codes } = await sb.from('verification_codes')
      .select('phone, used').eq('phone', KNOWN_PHONE)
    assert((codes?.length ?? 0) === 1, 'exactly one fresh code issued')
    assert(codes![0].used === false, 'fresh code not yet used')

    console.log('\n✓ ALL CHECK-PHONE E2E ASSERTIONS PASSED')
  } finally {
    await cleanup()
  }
}

main().catch(e => { console.error(e); cleanup().finally(() => process.exit(1)) })
