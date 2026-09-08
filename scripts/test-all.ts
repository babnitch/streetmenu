// The runner — TEST-PLAN.md §2.
//
// One child process per suite, via tsx. A suite that calls process.exit(1),
// hangs or hard-crashes takes down only itself; the runner still reports the
// rest and still runs the post-sweep.
//
//   npx tsx scripts/test-all.ts [--only <glob>] [--skip unit|db|api] [--bail]
//                               [--verbose] [--require-api] [--sweep-only]
//
// Exit code is 0 only when every selected suite passed AND the residue gate
// found nothing. See §4: teardown code can be buggy, so the actual guarantee
// is the independent pattern count, not the cleanup.

import { spawn, spawnSync } from 'child_process'
import { readdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { randomBytes } from 'crypto'
import { isSupabaseConfigured, BASE } from './testkit/env'
import { RESULT_MARKER } from './testkit/assert'
import { listLedgers, teardownFromLedger, dropLedger } from './testkit/ledger'

const SUITES_DIR = resolve(process.cwd(), 'scripts', 'suites')
const TSX = resolve(process.cwd(), 'node_modules', '.bin', 'tsx')

type Group = 'unit' | 'db' | 'api' | 'smoke'

interface Suite { name: string; file: string; group: Group }

interface SuiteOutcome {
  suite:   string
  group:   Group
  status:  'passed' | 'failed' | 'skipped' | 'crashed'
  passed:  number
  failed:  number
  ms:      number
  reason?: string
}

// ── CLI ─────────────────────────────────────────────────────────────────────
interface Args {
  only:       string | null
  skip:       Group[]
  bail:       boolean
  verbose:    boolean
  requireApi: boolean
  sweepOnly:  boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = { only: null, skip: [], bail: false, verbose: false, requireApi: false, sweepOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--only') a.only = argv[++i] ?? null
    else if (v.startsWith('--only=')) a.only = v.split('=')[1]
    else if (v === '--skip') a.skip.push(...splitGroups(argv[++i]))
    else if (v.startsWith('--skip=')) a.skip.push(...splitGroups(v.split('=')[1]))
    else if (v === '--bail') a.bail = true
    else if (v === '--verbose' || v === '-v') a.verbose = true
    else if (v === '--require-api') a.requireApi = true
    else if (v === '--sweep-only') a.sweepOnly = true
    else if (v === '--help' || v === '-h') { usage(); process.exit(0) }
    else { console.error(`unknown flag: ${v}`); usage(); process.exit(2) }
  }
  return a
}

function splitGroups(s: string | undefined): Group[] {
  if (!s) return []
  const valid: Group[] = ['unit', 'db', 'api', 'smoke']
  const out: Group[] = []
  for (const part of s.split(',').map(x => x.trim()).filter(Boolean)) {
    if (!(valid as string[]).includes(part)) {
      console.error(`--skip: unknown group "${part}" (expected one of ${valid.join(', ')})`)
      process.exit(2)
    }
    out.push(part as Group)
  }
  return out
}

function usage(): void {
  console.log(`
test-all — run the functional regression suites

  --only <glob>    only suites matching the glob, e.g. --only 'unit-*'
  --skip <groups>  comma-separated: unit, db, api, smoke
  --bail           stop at the first failing suite
  --verbose        stream each suite's own output
  --require-api    fail (rather than skip) when no server is reachable
  --sweep-only     run the pre-sweep and the residue gate, no suites
`.trim())
}

// Minimal glob: * matches any run of characters. Enough for 'unit-*'.
function globToRe(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

function groupOf(name: string): Group {
  if (name.startsWith('unit-'))  return 'unit'
  if (name.startsWith('db-'))    return 'db'
  if (name.startsWith('smoke-')) return 'smoke'
  return 'api'
}

function discover(): Suite[] {
  if (!existsSync(SUITES_DIR)) return []
  return readdirSync(SUITES_DIR)
    .filter(f => f.endsWith('.ts') && !f.startsWith('_'))
    .map(f => f.replace(/\.ts$/, ''))
    .sort()
    .map(name => ({ name, file: join(SUITES_DIR, `${name}.ts`), group: groupOf(name) }))
}

// ── Running one suite ───────────────────────────────────────────────────────
function runSuite(s: Suite, runId: string, verbose: boolean): Promise<SuiteOutcome> {
  return new Promise(resolveOutcome => {
    const started = Date.now()
    const child = spawn(TSX, [s.file], {
      env: { ...process.env, TEST_RUN_ID: runId, FORCE_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let errOut = ''
    child.stdout.on('data', d => {
      const chunk = String(d)
      out += chunk
      if (verbose) process.stdout.write(chunk)
    })
    child.stderr.on('data', d => {
      const chunk = String(d)
      errOut += chunk
      if (verbose) process.stderr.write(chunk)
    })

    child.on('error', e => {
      resolveOutcome({
        suite: s.name, group: s.group, status: 'crashed', passed: 0, failed: 0,
        ms: Date.now() - started, reason: e.message,
      })
    })

    child.on('close', (code, signal) => {
      const ms = Date.now() - started
      const marker = out.split('\n').reverse().find(l => l.includes(RESULT_MARKER))
      let counts: { passed: number; failed: number } | null = null
      if (marker) {
        try {
          counts = JSON.parse(marker.slice(marker.indexOf(RESULT_MARKER) + RESULT_MARKER.length))
        } catch { /* fall through to the exit code */ }
      }

      // No marker means the suite died before finish() — a crash, regardless
      // of what the exit code says.
      if (!counts) {
        const tail = (errOut || out).trim().split('\n').slice(-3).join(' | ')
        resolveOutcome({
          suite: s.name, group: s.group, status: 'crashed', passed: 0, failed: 0, ms,
          reason: signal ? `killed by ${signal}` : `exit ${code} with no result marker — ${tail || 'no output'}`,
        })
        return
      }

      resolveOutcome({
        suite: s.name, group: s.group,
        status: counts.failed === 0 && code === 0 ? 'passed' : 'failed',
        passed: counts.passed, failed: counts.failed, ms,
      })
    })
  })
}

// ── Sweep helpers ───────────────────────────────────────────────────────────
function sweep(mode: 'confirm' | 'count', olderThan?: string): { count: number; ok: boolean; output: string } {
  const args = ['scripts/test-sweep.ts', '--all']
  if (mode === 'confirm') { args.push('--confirm'); if (olderThan) args.push('--older-than', olderThan) }
  else args.push('--count-only')

  const r = spawnSync(TSX, args, { encoding: 'utf8', env: process.env })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (mode === 'count') {
    const last = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '0'
    const n = Number(last)
    return { count: Number.isFinite(n) ? n : 0, ok: r.status === 0, output }
  }
  return { count: 0, ok: r.status === 0, output }
}

async function serverIsUp(): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 4000)
    const res = await fetch(`${BASE}/api/auth/me`, { signal: ctl.signal })
    clearTimeout(t)
    return res.status > 0 && res.status < 500
  } catch {
    return false
  }
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const runId = randomBytes(3).toString('hex')

  if (!existsSync(TSX)) {
    console.error(`✗ tsx not found at ${TSX} — run "npm install"`)
    process.exit(2)
  }

  let suites = discover()
  if (args.only) {
    const re = globToRe(args.only)
    suites = suites.filter(s => re.test(s.name))
  }
  if (args.skip.length) suites = suites.filter(s => !args.skip.includes(s.group))

  const needsDb = suites.some(s => s.group !== 'unit')

  console.log(`\n━━ functional regression suite ━━`)
  console.log(`   run ${runId} · ${suites.length} suite(s)${args.only ? ` matching "${args.only}"` : ''}`)
  if (needsDb) console.log(`   target ${BASE}`)

  // 1. Recover ledgers left behind by a previous crashed run.
  if (isSupabaseConfigured()) {
    for (const stale of listLedgers()) {
      if (stale === runId) continue
      const r = await teardownFromLedger(stale)
      const n = Object.values(r.deleted).reduce((a, b) => a + b, 0)
      if (n > 0) console.log(`   recovered ledger ${stale}: removed ${n} row(s)`)
      dropLedger(stale)
    }
  }

  // 2. Pre-sweep. Unit-only runs write nothing, so there is nothing to clean
  //    and no reason to demand credentials.
  if (needsDb && isSupabaseConfigured()) {
    const pre = sweep('confirm')
    if (!pre.ok && args.verbose) console.log(pre.output)
    console.log(`   pre-sweep done`)
  } else if (needsDb) {
    console.log(`   pre-sweep skipped — Supabase not configured`)
  }

  if (args.sweepOnly) {
    const gate = isSupabaseConfigured() ? sweep('count') : { count: 0, ok: true, output: '' }
    console.log(`\n   residue: ${gate.count}`)
    process.exit(gate.count === 0 ? 0 : 1)
  }

  if (suites.length === 0) {
    console.log('\n   no suites matched — nothing to do')
    process.exit(0)
  }

  // 3. Preflight for the server-dependent groups.
  let apiUp = true
  if (suites.some(s => s.group === 'api' || s.group === 'smoke')) {
    apiUp = await serverIsUp()
    console.log(`   server ${apiUp ? 'reachable' : 'NOT reachable'} at ${BASE}`)
  }

  // 4. Unit suites in parallel (they share no state); everything else in
  //    sequence — rate limits and shared counters make parallelism a
  //    flakiness source rather than a speed win.
  const unit = suites.filter(s => s.group === 'unit')
  const rest = suites.filter(s => s.group !== 'unit')
  const outcomes: SuiteOutcome[] = []

  console.log('')
  if (unit.length) {
    const parallel = await Promise.all(unit.map(s => runSuite(s, runId, args.verbose)))
    for (const o of parallel) { outcomes.push(o); printLine(o) }
  }

  let bailed = false
  for (const s of rest) {
    if (bailed) {
      outcomes.push({ suite: s.name, group: s.group, status: 'skipped', passed: 0, failed: 0, ms: 0, reason: 'bailed' })
      continue
    }
    if ((s.group === 'api' || s.group === 'smoke') && !apiUp) {
      const o: SuiteOutcome = {
        suite: s.name, group: s.group, status: 'skipped', passed: 0, failed: 0, ms: 0,
        reason: `no server at ${BASE}`,
      }
      outcomes.push(o); printLine(o)
      continue
    }
    if (s.group === 'db' && !isSupabaseConfigured()) {
      const o: SuiteOutcome = {
        suite: s.name, group: s.group, status: 'skipped', passed: 0, failed: 0, ms: 0,
        reason: 'Supabase not configured',
      }
      outcomes.push(o); printLine(o)
      continue
    }
    const o = await runSuite(s, runId, args.verbose)
    outcomes.push(o); printLine(o)
    if (args.bail && (o.status === 'failed' || o.status === 'crashed')) bailed = true
  }

  // 5. Post-sweep, then the independent residue gate.
  let residue = 0
  if (needsDb && isSupabaseConfigured()) {
    const post = sweep('confirm')
    if (!post.ok && args.verbose) console.log(post.output)
    const gate = sweep('count')
    residue = gate.count
  }

  // 6. Summary.
  const totalPassed = outcomes.reduce((s, o) => s + o.passed, 0)
  const totalFailed = outcomes.reduce((s, o) => s + o.failed, 0)
  const badSuites = outcomes.filter(o => o.status === 'failed' || o.status === 'crashed')
  const skipped = outcomes.filter(o => o.status === 'skipped')

  console.log(`\n━━ summary ━━`)
  console.log(`   ${outcomes.length - skipped.length} suite(s) run · ${totalPassed} assertions passed · ${totalFailed} failed`)
  if (skipped.length) console.log(`   ${skipped.length} suite(s) skipped`)
  if (needsDb) console.log(`   residue: ${residue} row(s)${residue === 0 ? ' ✓' : ' ✗'}`)
  if (badSuites.length) {
    console.log(`\n   failing suites:`)
    for (const o of badSuites) console.log(`     ✗ ${o.suite}${o.reason ? ` — ${o.reason}` : ` (${o.failed} failed)`}`)
  }

  // --require-api turns a skipped API suite into a failure. Without it, a run
  // on a machine with no dev server still reports the unit results honestly.
  const skippedForApi = skipped.filter(o => o.reason?.startsWith('no server'))
  const apiGate = args.requireApi && skippedForApi.length > 0
  if (apiGate) console.log(`\n   ✗ --require-api: ${skippedForApi.length} suite(s) skipped because no server was reachable`)

  const ok = badSuites.length === 0 && residue === 0 && !apiGate
  console.log(`\n${ok ? '✓ PASS' : '✗ FAIL'}\n`)
  process.exit(ok ? 0 : 1)
}

function printLine(o: SuiteOutcome): void {
  const pad = o.suite.padEnd(26)
  if (o.status === 'passed')  console.log(`  ✓ ${pad} ${String(o.passed).padStart(3)} passed  ${fmtMs(o.ms)}`)
  else if (o.status === 'failed')  console.log(`  ✗ ${pad} ${o.passed} passed, ${o.failed} failed  ${fmtMs(o.ms)}`)
  else if (o.status === 'crashed') console.log(`  ✗ ${pad} CRASHED — ${o.reason}`)
  else console.log(`  ⊘ ${pad} SKIPPED — ${o.reason}`)
}

void main()
