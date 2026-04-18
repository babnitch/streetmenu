// Show the customers the release-number button is allowed to act on,
// and cross-reference with audit_log to highlight already-released ones.
// Usage: node --env-file=.env.local scripts/release-state.mjs

import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

// Everyone soft-deleted
const { data: deleted } = await sb
  .from('customers')
  .select('id, name, phone, city, status, deleted_at, created_at')
  .not('deleted_at', 'is', null)
  .order('deleted_at', { ascending: false })

console.log(`\n=== Soft-deleted customers (${deleted?.length ?? 0}) ===`)
for (const c of deleted ?? []) {
  const anon = (c.phone ?? '').startsWith('deleted_')
  console.log(
    `${anon ? 'ANON ' : 'LIVE '} ${c.id}  deleted_at=${c.deleted_at}  phone=${c.phone}  name=${c.name}`
  )
}

// Released audits
const { data: audits } = await sb
  .from('audit_log')
  .select('id, target_id, created_at, previous_data')
  .eq('action', 'number_released')
  .order('created_at', { ascending: false })

console.log(`\n=== number_released audit entries (${audits?.length ?? 0}) ===`)
for (const a of audits ?? []) {
  const phone = a.previous_data?.customer?.phone
  console.log(`${a.created_at}  target=${a.target_id}  prev_phone=${phone}`)
}

// Highlight: any LIVE soft-deleted customer is the one the button would act on
const eligible = (deleted ?? []).filter(c => !(c.phone ?? '').startsWith('deleted_'))
console.log(`\n=== ELIGIBLE for release (${eligible.length}) ===`)
for (const c of eligible) {
  console.log(`  id=${c.id} phone=${c.phone} name=${c.name}`)
}
