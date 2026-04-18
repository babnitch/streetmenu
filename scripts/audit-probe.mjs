// Diagnostic probe for the audit_log table.
// Usage:  node --env-file=.env.local scripts/audit-probe.mjs
//
// Prints:
//   - whether audit_log exists (tries a SELECT)
//   - whether the service role can INSERT a dummy row (then deletes it)
//   - the full Supabase error payload if either step fails

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

console.log(`Connecting to ${url}`)

// 1) SELECT
const { data: rows, error: selErr, count } = await sb
  .from('audit_log')
  .select('id, action, created_at', { count: 'exact' })
  .limit(3)

if (selErr) {
  console.error('[SELECT] FAILED')
  console.error('  code:    ', selErr.code)
  console.error('  message: ', selErr.message)
  console.error('  details: ', selErr.details)
  console.error('  hint:    ', selErr.hint)
  console.error('  → If code is 42P01, the table does not exist. Run supabase-audit-log.sql.')
} else {
  console.log(`[SELECT] OK — ${count ?? rows?.length ?? 0} row(s) total`)
  for (const r of rows ?? []) console.log(`   ${r.created_at} ${r.action} ${r.id}`)
}

// 2) INSERT (only if SELECT worked)
if (!selErr) {
  const testId = '00000000-0000-0000-0000-000000000000'
  const { data: ins, error: insErr } = await sb
    .from('audit_log')
    .insert({
      action:            'probe_test',
      target_type:       'customer',
      target_id:         testId,
      performed_by:      null,
      performed_by_type: 'system',
      previous_data:     { probe: true },
      metadata:          { note: 'diagnostic probe — safe to delete' },
    })
    .select('id').single()

  if (insErr) {
    console.error('[INSERT] FAILED')
    console.error('  code:    ', insErr.code)
    console.error('  message: ', insErr.message)
    console.error('  details: ', insErr.details)
    console.error('  hint:    ', insErr.hint)
  } else {
    console.log(`[INSERT] OK — inserted id ${ins.id} (cleaning up)`)
    await sb.from('audit_log').delete().eq('id', ins.id)
    console.log('[CLEANUP] probe row deleted')
  }
}
