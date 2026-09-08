// Durable record of everything a run inserted, so teardown survives a crash.
//
// Layer 2 of the three guarantees in TEST-PLAN.md §4. fixtures.ts calls
// track() on every insert; each call rewrites scripts/.testrun/<RUN_ID>.json
// (write-temp-then-rename, so a kill mid-write leaves the previous complete
// file rather than a truncated one). If a suite is SIGKILLed and its finally
// block never runs, the runner reads that file and tears down on its behalf.
//
// The ledger is a convenience, not the guarantee. test-sweep.ts works from
// the reserved-namespace patterns alone and does not read these files — that
// is deliberate, because the ledger can itself be buggy.

import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import { sb, RUN_ID, isSupabaseConfigured, TEST_PHONE_LIKE } from './env'

export const TESTRUN_DIR = resolve(process.cwd(), 'scripts', '.testrun')

export interface LedgerRow { table: string; id: string }
export interface LedgerFile {
  runId:     string
  startedAt: string
  rows:      LedgerRow[]
}

const rows: LedgerRow[] = []
let dirty = false

function ledgerPath(runId: string = RUN_ID): string {
  return join(TESTRUN_DIR, `${runId}.json`)
}

export function writeLedger(runId: string = RUN_ID): void {
  try {
    mkdirSync(TESTRUN_DIR, { recursive: true })
    const payload: LedgerFile = { runId, startedAt: startedAt, rows }
    const tmp = `${ledgerPath(runId)}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, ledgerPath(runId))
  } catch (e) {
    // A ledger we can't persist is a downgrade to layer 1 + layer 3, not a
    // reason to fail the test that was about to run.
    console.warn(`  ⚠ ledger write failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const startedAt = new Date().toISOString()

// Record an inserted row. Synchronous on purpose — an async flush could lose
// the last insert to a SIGKILL, which is precisely the case this exists for.
export function track(table: string, id: string | null | undefined): void {
  if (!id) return
  rows.push({ table, id })
  dirty = true
  writeLedger()
}

export function tracked(): readonly LedgerRow[] { return rows }

export function readLedger(runId: string): LedgerFile | null {
  const p = ledgerPath(runId)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LedgerFile
  } catch {
    return null
  }
}

export function listLedgers(): string[] {
  try {
    return readdirSync(TESTRUN_DIR)
      .filter(f => /^[0-9a-f]{6}\.json$/.test(f))
      .map(f => f.replace(/\.json$/, ''))
  } catch {
    return []
  }
}

export function dropLedger(runId: string = RUN_ID): void {
  try { unlinkSync(ledgerPath(runId)) } catch { /* already gone */ }
}

// ── Delete order ────────────────────────────────────────────────────────────
// Children before parents. Two constraints drive this list (TEST-PLAN §4):
//   - the restaurant_team owner trigger means a restaurant always has at
//     least one team row, so team rows must go before restaurants;
//   - order_items / event_reservations FK to their parents.
export const DELETE_ORDER: string[] = [
  'order_items',
  'orders',
  'event_reservations',
  'event_ticket_tiers',
  'event_comments',
  'event_likes',
  'events',
  'customer_vouchers',
  'vouchers',
  'team_invitations',
  'restaurant_team',
  'restaurant_hours',
  'menu_items',
  'restaurants',
  'restaurant_ratings',
  'reports',
  'promotions',
  'broadcasts',
  'event_subscriptions',
  'signup_sessions',
  'verification_codes',
  'message_log',
  'audit_log',
  'customers',
]

export interface TeardownReport {
  deleted: Record<string, number>
  errors:  string[]
}

// Deletes everything this process tracked, plus the phone-keyed rows that
// have no id in the ledger (sessions, codes, message log). Safe to call more
// than once — a second run simply deletes nothing.
export async function teardown(opts: { verbose?: boolean } = {}): Promise<TeardownReport> {
  const report: TeardownReport = { deleted: {}, errors: [] }
  if (!isSupabaseConfigured()) return report
  if (rows.length === 0) {
    // Still clear phone-keyed residue: a suite may have driven the API into
    // creating sessions/codes it never tracked directly.
    await deletePhoneKeyed(report)
    return report
  }

  const byTable = new Map<string, string[]>()
  for (const r of rows) {
    const list = byTable.get(r.table) ?? []
    list.push(r.id)
    byTable.set(r.table, list)
  }

  // Children the suite never created directly — a voucher claim made through
  // the API, order_items written by the ordering webhook, the trigger's own
  // team row. Nothing tracked them, but they hold FKs onto rows that ARE
  // tracked, so the ordered pass below would fail on the constraint. Clear
  // them from the tracked parents first.
  await deleteCascades(byTable, report)

  for (const table of DELETE_ORDER) {
    const ids = byTable.get(table)
    if (!ids || ids.length === 0) continue
    const unique = Array.from(new Set(ids))
    const { error, count } = await sb.from(table).delete({ count: 'exact' }).in('id', unique)
    if (error) {
      report.errors.push(`${table}: ${error.message}`)
    } else {
      report.deleted[table] = (report.deleted[table] ?? 0) + (count ?? 0)
    }
    byTable.delete(table)
  }

  // Anything tracked under a table the order doesn't know about — delete it
  // last and complain, so a new fixture table gets added to DELETE_ORDER.
  for (const [table, ids] of Array.from(byTable.entries())) {
    report.errors.push(`${table} is not in DELETE_ORDER — deleted last, add it`)
    const { error, count } = await sb.from(table).delete({ count: 'exact' }).in('id', Array.from(new Set(ids)))
    if (error) report.errors.push(`${table}: ${error.message}`)
    else report.deleted[table] = count ?? 0
  }

  await deletePhoneKeyed(report)

  if (opts.verbose) {
    for (const [t, n] of Object.entries(report.deleted)) if (n > 0) console.log(`  · ${t}: ${n}`)
  }
  dirty = false
  return report
}

// Child rows reachable from a tracked parent id. Ordered deepest-first: a
// two-level case (order_items under orders under a restaurant) resolves the
// intermediate ids as it goes.
async function deleteCascades(
  byTable: Map<string, string[]>,
  report: TeardownReport,
): Promise<void> {
  const ids = (table: string): string[] => Array.from(new Set(byTable.get(table) ?? []))

  const restaurants = ids('restaurants')
  const customers   = ids('customers')
  const vouchers    = ids('vouchers')
  const events      = ids('events')
  const orders      = ids('orders')

  const del = async (table: string, column: string, values: string[]) => {
    if (values.length === 0) return
    const { error, count } = await sb.from(table).delete({ count: 'exact' }).in(column, values)
    if (error) report.errors.push(`${table} by ${column}: ${error.message}`)
    else if (count) report.deleted[table] = (report.deleted[table] ?? 0) + count
  }

  // Orders reachable from a tracked restaurant or customer, plus the ones we
  // tracked directly — their order_items must go first.
  const orderIds = new Set(orders)
  for (const [col, parents] of [['restaurant_id', restaurants], ['customer_id', customers]] as const) {
    if (parents.length === 0) continue
    const { data } = await sb.from('orders').select('id').in(col, parents)
    for (const r of (data ?? []) as Array<{ id: string }>) orderIds.add(r.id)
  }
  await del('order_items', 'order_id', Array.from(orderIds))
  await del('orders', 'id', Array.from(orderIds))

  // Voucher claims block both the voucher and the customer.
  await del('customer_vouchers', 'voucher_id', vouchers)
  await del('customer_vouchers', 'customer_id', customers)

  // Event children.
  await del('event_reservations', 'event_id', events)
  await del('event_reservations', 'customer_id', customers)
  await del('event_ticket_tiers', 'event_id', events)

  // Restaurant children, including the trigger-created owner team row.
  await del('menu_items', 'restaurant_id', restaurants)
  await del('restaurant_hours', 'restaurant_id', restaurants)
  await del('team_invitations', 'restaurant_id', restaurants)
  await del('restaurant_team', 'restaurant_id', restaurants)
  await del('restaurant_team', 'customer_id', customers)
  await del('restaurant_ratings', 'restaurant_id', restaurants)
}

// Rows keyed by phone rather than by an id we captured. audit_log is keyed by
// the ledger's ids instead, since it has no phone column.
async function deletePhoneKeyed(report: TeardownReport): Promise<void> {
  const phoneTables: Array<[string, string]> = [
    ['signup_sessions',    'phone'],
    ['verification_codes', 'phone'],
    ['message_log',        'to_number'],
  ]
  for (const [table, col] of phoneTables) {
    const { error, count } = await sb.from(table).delete({ count: 'exact' }).like(col, TEST_PHONE_LIKE)
    if (error) report.errors.push(`${table}: ${error.message}`)
    else if (count) report.deleted[table] = (report.deleted[table] ?? 0) + count
  }

  const ids = Array.from(new Set(rows.map(r => r.id)))
  if (ids.length > 0) {
    const { error, count } = await sb.from('audit_log').delete({ count: 'exact' }).in('target_id', ids)
    if (error) report.errors.push(`audit_log: ${error.message}`)
    else if (count) report.deleted['audit_log'] = (report.deleted['audit_log'] ?? 0) + count
  }
}

// Tear down a run this process did not own — used by the runner when a child
// suite dies without cleaning up after itself.
export async function teardownFromLedger(runId: string): Promise<TeardownReport> {
  const file = readLedger(runId)
  const report: TeardownReport = { deleted: {}, errors: [] }
  if (!file || !isSupabaseConfigured()) return report

  const byTable = new Map<string, string[]>()
  for (const r of file.rows) {
    const list = byTable.get(r.table) ?? []
    list.push(r.id)
    byTable.set(r.table, list)
  }
  for (const table of DELETE_ORDER) {
    const ids = byTable.get(table)
    if (!ids?.length) continue
    const { error, count } = await sb.from(table).delete({ count: 'exact' }).in('id', Array.from(new Set(ids)))
    if (error) report.errors.push(`${table}: ${error.message}`)
    else report.deleted[table] = count ?? 0
  }
  return report
}

// ── Crash safety ────────────────────────────────────────────────────────────
// Installed once per process by the first suite that imports fixtures. Runs
// teardown before the process goes away, then re-raises the original exit.
let handlersInstalled = false
export function installCleanupHandlers(): void {
  if (handlersInstalled) return
  handlersInstalled = true

  const run = async (why: string, code: number) => {
    if (dirty) {
      console.log(`\n⚠ ${why} — running teardown for run ${RUN_ID}`)
      try {
        const r = await teardown()
        if (r.errors.length) for (const e of r.errors) console.warn(`  ⚠ ${e}`)
      } catch (e) {
        console.warn(`  ⚠ teardown failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    process.exit(code)
  }

  process.on('SIGINT',  () => { void run('SIGINT', 130) })
  process.on('SIGTERM', () => { void run('SIGTERM', 143) })
  process.on('uncaughtException', (e) => {
    console.error('uncaught exception:', e)
    void run('uncaughtException', 1)
  })
  process.on('unhandledRejection', (e) => {
    console.error('unhandled rejection:', e)
    void run('unhandledRejection', 1)
  })
}
