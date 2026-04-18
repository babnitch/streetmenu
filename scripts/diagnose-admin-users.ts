import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Minimal .env.local loader to avoid adding a runtime dependency.
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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(1)
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const { data, error } = await sb
    .from('admin_users')
    .select('id, email, name, role, status, password_hash, created_at')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Supabase error:', error)
    process.exit(1)
  }

  console.log(`Found ${data?.length ?? 0} admin_users row(s):\n`)
  for (const r of data ?? []) {
    const h = r.password_hash ?? ''
    console.log({
      id: r.id,
      email: JSON.stringify(r.email),
      name: r.name,
      role: r.role,
      status: r.status,
      hash_prefix: h.slice(0, 4),
      hash_length: h.length,
      hash_looks_like_bcrypt: /^\$2[aby]\$/.test(h),
      created_at: r.created_at,
    })
  }
}
main()
