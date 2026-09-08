// Standalone residue sweeper — layer 3 of TEST-PLAN.md §4.
//
// Works from the reserved-namespace patterns alone and never reads a ledger,
// on purpose: the ledger is the thing this exists to back up. That makes it
// able to clean residue from a run whose process was SIGKILLed, or from
// before the ledger existed at all.
//
//   npx tsx scripts/test-sweep.ts                 # dry run
//   npx tsx scripts/test-sweep.ts --all           # dry run until confirmed
//   npx tsx scripts/test-sweep.ts --all --confirm # actually delete
//   npx tsx scripts/test-sweep.ts --older-than 1h # leave a concurrent run alone
//   npx tsx scripts/test-sweep.ts --count-only    # residue gate for the runner
//
// SAFETY: the first invocation on a machine is ALWAYS a dry run, even with
// --confirm, and it writes no marker until you have seen the numbers. This
// answers TEST-PLAN.md §7's open question directly — the historical +999 rows
// that have been accumulating get inspected before anything deletes them.

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { sb, isSupabaseConfigured, TEST_PHONE_LIKE, TEST_NAME_LIKE, TEST_CODE_LIKE } from './testkit/env'
import { TESTRUN_DIR } from './testkit/ledger'

const SEEN_MARKER = join(TESTRUN_DIR, '.sweep-inspected')

// ── Pattern table ───────────────────────────────────────────────────────────
// Order matters: children before parents, same as ledger.ts DELETE_ORDER.
type Match =
  | { kind: 'like';   column: string; pattern: string }
  | { kind: 'in_sub'; column: string; from: string; fromColumn: string; via: Match }

interface SweepTarget {
  table: string
  match: Match
  /** Why this pattern is safe — printed in --verbose. */
  note: string
}

const NAME: (c: string) => Match = c => ({ kind: 'like', column: c, pattern: TEST_NAME_LIKE })
const PHONE: (c: string) => Match = c => ({ kind: 'like', column: c, pattern: TEST_PHONE_LIKE })

const TARGETS: SweepTarget[] = [
  // Children of test restaurants / events, reached through their parent.
  { table: 'order_items', note: 'items of orders placed by a +999 phone',
    match: { kind: 'in_sub', column: 'order_id', from: 'orders', fromColumn: 'id', via: PHONE('customer_phone') } },
  { table: 'orders', note: 'orders placed by a +999 phone', match: PHONE('customer_phone') },

  { table: 'event_reservations', note: 'reservations made by a +999 phone', match: PHONE('customer_phone') },
  { table: 'event_ticket_tiers', note: 'tiers of __t_…__ events',
    match: { kind: 'in_sub', column: 'event_id', from: 'events', fromColumn: 'id', via: NAME('title') } },
  { table: 'events', note: '__t_…__ events', match: NAME('title') },

  { table: 'customer_vouchers', note: 'claims on __T_…__ vouchers',
    match: { kind: 'in_sub', column: 'voucher_id', from: 'vouchers', fromColumn: 'id', via: { kind: 'like', column: 'code', pattern: TEST_CODE_LIKE } } },
  { table: 'vouchers', note: '__T_…__ voucher codes', match: { kind: 'like', column: 'code', pattern: TEST_CODE_LIKE } },

  { table: 'team_invitations', note: 'invitations to a +999 phone', match: PHONE('phone') },
  { table: 'restaurant_team', note: 'team rows of __t_…__ restaurants',
    match: { kind: 'in_sub', column: 'restaurant_id', from: 'restaurants', fromColumn: 'id', via: NAME('name') } },
  { table: 'restaurant_hours', note: 'hours of __t_…__ restaurants',
    match: { kind: 'in_sub', column: 'restaurant_id', from: 'restaurants', fromColumn: 'id', via: NAME('name') } },
  { table: 'menu_items', note: 'items of __t_…__ restaurants',
    match: { kind: 'in_sub', column: 'restaurant_id', from: 'restaurants', fromColumn: 'id', via: NAME('name') } },
  { table: 'restaurants', note: '__t_…__ restaurants', match: NAME('name') },

  { table: 'signup_sessions',   note: 'sessions for a +999 phone', match: PHONE('phone') },
  { table: 'verification_codes', note: 'codes sent to a +999 phone', match: PHONE('phone') },
  { table: 'message_log',       note: 'messages addressed to a +999 phone', match: PHONE('to_number') },

  { table: 'customers', note: '+999 test customers — deleted last, everything above FKs to them', match: PHONE('phone') },
]

// ── CLI ─────────────────────────────────────────────────────────────────────
interface Args {
  all: boolean
  confirm: boolean
  dryRun: boolean
  countOnly: boolean
  verbose: boolean
  olderThanMs: number | null
}

function parseArgs(argv: string[]): Args {
  const a: Args = { all: false, confirm: false, dryRun: false, countOnly: false, verbose: false, olderThanMs: null }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--all') a.all = true
    else if (v === '--confirm') a.confirm = true
    else if (v === '--dry-run') a.dryRun = true
    else if (v === '--count-only') a.countOnly = true
    else if (v === '--verbose' || v === '-v') a.verbose = true
    else if (v === '--older-than') a.olderThanMs = parseDuration(argv[++i])
    else if (v.startsWith('--older-than=')) a.olderThanMs = parseDuration(v.split('=')[1])
    else if (v === '--help' || v === '-h') { usage(); process.exit(0) }
    else { console.error(`unknown flag: ${v}`); usage(); process.exit(2) }
  }
  return a
}

function parseDuration(s: string | undefined): number | null {
  if (!s) return null
  const m = s.match(/^(\d+)\s*(ms|s|m|h|d)$/i)
  if (!m) { console.error(`bad --older-than value: ${s} (try 30m, 1h, 2d)`); process.exit(2) }
  const n = parseInt(m[1], 10)
  const unit = m[2].toLowerCase()
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return n * mult[unit]
}

function usage(): void {
  console.log(`
test-sweep — delete test residue by reserved-namespace pattern

  --all            sweep every table in the pattern table
  --confirm        actually delete (without it, nothing is deleted)
  --dry-run        force a dry run even with --confirm
  --older-than D   only rows created before now-D (30m, 1h, 2d) — protects a concurrent run
  --count-only     print the residue count and exit; used as the runner's final gate
  --verbose        show the pattern and reasoning per table

The FIRST run on a machine is always a dry run, whatever flags are passed.
Re-run with --confirm once you have read the numbers.
`.trim())
}

// ── Counting / deleting ─────────────────────────────────────────────────────
async function resolveIds(m: Match): Promise<string[] | null> {
  if (m.kind !== 'in_sub') return null
  const inner = m.via
  if (inner.kind !== 'like') return null
  const { data, error } = await sb.from(m.from).select(m.fromColumn).like(inner.column, inner.pattern)
  if (error) throw new Error(error.message)
  return (data ?? []).map(r => (r as unknown as Record<string, unknown>)[m.fromColumn] as string)
}

interface TableResult { table: string; count: number; deleted: number; error?: string; skipped?: boolean }

async function sweepTable(t: SweepTarget, args: Args): Promise<TableResult> {
  const res: TableResult = { table: t.table, count: 0, deleted: 0 }
  try {
    // select('*') with head:true counts without returning rows and, unlike
    // select('id'), works on tables with no `id` column — signup_sessions is
    // keyed by phone, and asking for `id` there fails with an empty message.
    let q = sb.from(t.table).select('*', { count: 'exact', head: true })

    if (t.match.kind === 'like') {
      q = q.like(t.match.column, t.match.pattern)
    } else {
      const ids = await resolveIds(t.match)
      if (!ids || ids.length === 0) return res
      q = q.in(t.match.column, ids)
    }
    if (args.olderThanMs != null) {
      q = q.lt('created_at', new Date(Date.now() - args.olderThanMs).toISOString())
    }

    const { count, error } = await q
    if (error) {
      // A table that doesn't exist in this environment (pre-migration) is not
      // a sweep failure — report and move on.
      res.error = error.message
      res.skipped = true
      return res
    }
    res.count = count ?? 0
    if (res.count === 0 || !args.confirm || args.dryRun) return res

    let d = sb.from(t.table).delete({ count: 'exact' })
    if (t.match.kind === 'like') {
      d = d.like(t.match.column, t.match.pattern)
    } else {
      const ids = await resolveIds(t.match)
      if (!ids || ids.length === 0) return res
      d = d.in(t.match.column, ids)
    }
    if (args.olderThanMs != null) {
      d = d.lt('created_at', new Date(Date.now() - args.olderThanMs).toISOString())
    }
    const { count: delCount, error: delErr } = await d
    if (delErr) res.error = delErr.message
    else res.deleted = delCount ?? 0
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e)
    res.skipped = true
  }
  return res
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!isSupabaseConfigured()) {
    if (args.countOnly) { console.log('0'); process.exit(0) }
    console.error('✗ Supabase is not configured — set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(2)
  }

  // First-invocation guard. Even --confirm is downgraded to a dry run until
  // the operator has seen one report (TEST-PLAN.md §4 hazard 4, §7).
  const firstRun = !existsSync(SEEN_MARKER)
  const effectivelyDry = args.dryRun || !args.confirm || firstRun

  if (!args.countOnly) {
    console.log(`\n🧹 test-sweep — ${effectivelyDry ? 'DRY RUN (nothing will be deleted)' : 'DELETING'}`)
    if (firstRun && args.confirm) {
      console.log('   ⚠ First invocation on this machine: forced to a dry run so you can')
      console.log('     inspect the numbers before anything is deleted. Re-run --confirm after this.')
    }
    if (args.olderThanMs != null) {
      console.log(`   Only rows older than ${new Date(Date.now() - args.olderThanMs).toISOString()}`)
    }
    console.log('')
  }

  const runArgs: Args = { ...args, confirm: args.confirm && !effectivelyDry }
  const results: TableResult[] = []
  for (const t of TARGETS) {
    const r = await sweepTable(t, runArgs)
    results.push(r)
    if (args.countOnly) continue
    if (r.skipped) {
      console.log(`  ⊘ ${t.table.padEnd(20)} skipped — ${r.error || 'table not present or not readable'}`)
    } else if (r.count > 0) {
      const verb = runArgs.confirm ? `deleted ${r.deleted}` : `would delete ${r.count}`
      console.log(`  ${runArgs.confirm ? '✓' : '·'} ${t.table.padEnd(20)} ${verb}${r.error ? ` (error: ${r.error})` : ''}`)
      if (args.verbose) console.log(`      ${t.note}`)
    } else if (args.verbose) {
      console.log(`  · ${t.table.padEnd(20)} clean`)
    }
  }

  const totalFound = results.reduce((s, r) => s + r.count, 0)
  const totalDeleted = results.reduce((s, r) => s + r.deleted, 0)

  if (args.countOnly) {
    // The runner's residue gate reads exactly this one number from stdout.
    console.log(String(totalFound))
    process.exit(0)
  }

  console.log('')
  if (runArgs.confirm) {
    console.log(`🧹 deleted ${totalDeleted} row(s) across ${results.filter(r => r.deleted > 0).length} table(s)`)
  } else {
    console.log(`🧹 ${totalFound} row(s) match the test namespace across ${results.filter(r => r.count > 0).length} table(s)`)
    if (totalFound > 0) {
      console.log('   Nothing was deleted. Re-run with --confirm to delete.')
    }
  }

  // Record that a report has been seen, so a later --confirm is honoured.
  if (firstRun) {
    try {
      mkdirSync(TESTRUN_DIR, { recursive: true })
      writeFileSync(SEEN_MARKER, `first inspected ${new Date().toISOString()}\n`, 'utf8')
      console.log(`\n   Inspection recorded. --confirm will delete from now on.`)
    } catch { /* marker is a convenience; a failure just means another dry run */ }
  }

  const hardErrors = results.filter(r => r.error && !r.skipped)
  process.exitCode = hardErrors.length > 0 ? 1 : 0
}

void main()
