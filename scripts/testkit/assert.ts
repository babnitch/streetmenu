// Assertions that collect rather than abort.
//
// The existing scripts throw on the first failed assert, so one broken
// expectation hides every later one in that file. Here assert() records the
// outcome and returns a boolean; the suite runs to the end and reports
// everything at once. Only step() short-circuits, and only for its own block
// — a thrown error inside a step is that step's failure, not the run's.
//
// Nothing in this module calls process.exit(). finish() sets
// process.exitCode, which lets stdout flush and lets the runner read a clean
// exit status. See TEST-PLAN.md §2.

export interface TestResult {
  name:   string
  ok:     boolean
  detail?: string
  step?:  string
}

const results: TestResult[] = []
let currentStep: string | undefined

// Machine-readable trailer the runner parses instead of scraping the human
// output. Keep the prefix in sync with test-all.ts.
export const RESULT_MARKER = '##TESTKIT##'

export function results_(): readonly TestResult[] {
  return results
}

export function passed(): number { return results.filter(r => r.ok).length }
export function failed(): number { return results.filter(r => !r.ok).length }

function record(ok: boolean, name: string, detail?: string): boolean {
  results.push({ name, ok, detail, step: currentStep })
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
  return ok
}

export function assert(cond: unknown, name: string, detail?: string): boolean {
  return record(!!cond, name, cond ? undefined : (detail ?? 'expected truthy'))
}

// Deep-ish equality: primitives by ===, everything else by stable JSON.
// Enough for the shapes these suites compare (small objects and arrays) and
// avoids pulling in a matcher library.
export function assertEq<T>(actual: T, expected: T, name: string): boolean {
  const ok = eq(actual, expected)
  return record(ok, name, ok ? undefined : `got ${fmt(actual)}, want ${fmt(expected)}`)
}

export function assertNe<T>(actual: T, notExpected: T, name: string): boolean {
  const ok = !eq(actual, notExpected)
  return record(ok, name, ok ? undefined : `got ${fmt(actual)}, want anything else`)
}

// Substring match against an error/message string — the shape most of these
// libs return (bilingual "fr / en" strings).
export function assertIncludes(haystack: string | null | undefined, needle: string, name: string): boolean {
  const ok = typeof haystack === 'string' && haystack.toLowerCase().includes(needle.toLowerCase())
  return record(ok, name, ok ? undefined : `${fmt(haystack)} does not contain ${fmt(needle)}`)
}

export function assertThrows(fn: () => unknown, name: string): boolean {
  try {
    fn()
    return record(false, name, 'did not throw')
  } catch {
    return record(true, name)
  }
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  try {
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
  } catch {
    return false
  }
}

// Stable key order so {a,b} and {b,a} compare equal.
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

// Groups assertions under a heading. A throw inside the body is recorded as
// one failure for the step and the suite carries on with the next step.
export async function step(name: string, fn: () => void | Promise<void>): Promise<void> {
  console.log(`\n▸ ${name}`)
  const prev = currentStep
  currentStep = name
  try {
    await fn()
  } catch (e) {
    record(false, `${name} threw`, e instanceof Error ? e.message : String(e))
  } finally {
    currentStep = prev
  }
}

// Final summary. Sets process.exitCode (never exits) so the caller's own
// finally blocks — teardown, in DB/API suites — still run.
export function finish(suiteName: string): void {
  const p = passed()
  const f = failed()
  console.log(`\n${f === 0 ? '✓' : '✗'} ${suiteName}: ${p} passed, ${f} failed`)
  if (f > 0) {
    console.log('\nFailures:')
    for (const r of results.filter(x => !x.ok)) {
      console.log(`  ✗ ${r.step ? `[${r.step}] ` : ''}${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
    }
  }
  console.log(`${RESULT_MARKER}${JSON.stringify({ suite: suiteName, passed: p, failed: f })}`)
  process.exitCode = f === 0 ? 0 : 1
}
