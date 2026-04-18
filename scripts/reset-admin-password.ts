import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcryptjs'
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
  const [, , email, newPassword] = process.argv
  if (!email || !newPassword) {
    console.error('Usage: npx tsx scripts/reset-admin-password.ts <email> <new-password>')
    process.exit(1)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const normalized = email.toLowerCase().trim()
  const hash = await bcrypt.hash(newPassword, 10)

  const { data, error } = await sb
    .from('admin_users')
    .update({ password_hash: hash })
    .eq('email', normalized)
    .select('id, email, role, status')
    .maybeSingle()

  if (error) {
    console.error('Update failed:', error)
    process.exit(1)
  }
  if (!data) {
    console.error(`No admin_users row matched email ${JSON.stringify(normalized)}`)
    process.exit(1)
  }

  console.log('Password reset for:', data)

  const verify = await bcrypt.compare(newPassword, hash)
  console.log('Round-trip bcrypt.compare =', verify)
}
main()
