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

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const sb = createClient(url, key, { auth: { persistSession: false } })

  // Try via RPC if exec_sql exists; otherwise fall back to a probe-by-effect.
  // Supabase JS doesn't expose raw SQL without a pg RPC. Simplest: probe by
  // attempting an insert with status='cancelled'. If it succeeds we delete it;
  // if it fails with a check violation, user needs to run the SQL manually.

  const { data: probeRestaurants } = await sb
    .from('restaurants').select('id').limit(1)
  const rid = probeRestaurants?.[0]?.id
  if (!rid) {
    console.error('No restaurants to probe against')
    process.exit(1)
  }

  const { data: inserted, error: insErr } = await sb
    .from('orders')
    .insert({
      restaurant_id: rid,
      customer_name: '__probe__',
      customer_phone: '__probe__',
      items: [],
      total_price: 0,
      status: 'cancelled',
    })
    .select('id')
    .maybeSingle()

  if (insErr) {
    console.log('Probe insert failed — migration NOT applied. Error:')
    console.log(insErr.message)
    console.log('')
    console.log('Please run the SQL in supabase-orders-cancelled-status.sql in')
    console.log('the Supabase SQL editor, then re-run this script to verify.')
    process.exit(2)
  }

  console.log('Probe insert succeeded — migration IS applied.')
  if (inserted) {
    await sb.from('orders').delete().eq('id', inserted.id)
    console.log('Probe row cleaned up.')
  }
}
main()
