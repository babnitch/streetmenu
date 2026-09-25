// Payment reconcile (lib/payments-reconcile.ts + /api/payments/reconcile) and
// the shared internal bearer check (lib/internalAuth.ts).
//
// No I/O: the reconcile runner takes its DB / PawaPay / settle calls as
// injected deps, and the route is called in-process — an unauthorised call
// must be refused before anything touches the database, which is what makes
// it safe to run here with no credentials at all.

import { NextRequest } from 'next/server'
import { authorizeInternal } from '@/lib/internalAuth'
import {
  runReconcile, selectCandidates, RECONCILE_MAX_PER_RUN, RECONCILE_MIN_AGE_MS, RECONCILE_MAX_AGE_MS,
  RECONCILE_CONCURRENCY, type ReconcileDeps, type PendingDeposit,
} from '@/lib/payments-reconcile'
import type { DepositStatus } from '@/lib/pawapay'
import type { SettleResult } from '@/lib/payments-settle'
import { POST as reconcilePOST } from '@/app/api/payments/reconcile/route'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-payments-reconcile'
const SECRET = 'test-internal-secret-0123456789'
const NOW = Date.parse('2026-09-25T12:00:00Z')
const MIN = 60 * 1000

function req(auth?: string): NextRequest {
  return new NextRequest('https://streetmenu.vercel.app/api/payments/reconcile', {
    method: 'POST',
    headers: auth === undefined ? {} : { authorization: auth },
  })
}

function row(kind: PendingDeposit['kind'], n: number, ageMin: number): PendingDeposit {
  return { kind, id: `${kind}-${n}`, depositId: `dep-${kind}-${n}`, at: new Date(NOW - ageMin * MIN).toISOString() }
}

// Fake deps: rows keyed by table kind, a scripted PawaPay answer per
// deposit, and a record of every settle call.
function fakeDeps(rows: PendingDeposit[], answers: Record<string, string> = {}, opts: { throwOn?: string; stale?: number } = {}) {
  const settled: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const deps: ReconcileDeps = {
    async fetchPending(src, fromISO, toISO, limit) {
      // Mirrors the SQL: window + newest-first + limit, per table.
      return rows
        .filter(r => r.kind === src.kind && r.at >= fromISO && r.at <= toISO)
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, limit)
    },
    async countStale(src) { return src.kind === 'order' ? (opts.stale ?? 0) : 0 },
    async checkStatus(depositId): Promise<DepositStatus> {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 2))
      inFlight--
      if (depositId === opts.throwOn) throw new Error('PawaPay 502')
      return { status: (answers[depositId] ?? 'SUBMITTED') as DepositStatus['status'] }
    },
    async settle(depositId, outcome): Promise<SettleResult> {
      settled.push(depositId)
      const r = rows.find(x => x.depositId === depositId)!
      const action = outcome.status === 'COMPLETED' ? 'paid'
        : outcome.status === 'FAILED' || outcome.status === 'REJECTED' ? 'failed'
        : (outcome.status as string) === 'SETTLED_ELSEWHERE' ? 'already_settled' : 'not_final'
      return { kind: r.kind, id: r.id, action }
    },
    now: () => NOW,
  }
  return { deps, settled, maxInFlight: () => maxInFlight }
}

async function main() {
  const originalSecret = process.env.INTERNAL_API_SECRET

  await step('internal auth (lib/internalAuth.ts)', async () => {
    delete process.env.INTERNAL_API_SECRET
    const unset = authorizeInternal(req(`Bearer ${SECRET}`))
    assertEq(unset.ok ? 0 : unset.status, 503, 'secret unset → 503 (fail closed), even with a bearer')

    process.env.INTERNAL_API_SECRET = SECRET
    assertEq(authorizeInternal(req(`Bearer ${SECRET}`)).ok, true, 'correct bearer → ok')
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'no Authorization header'],
      ['', 'empty header'],
      [SECRET, 'secret without "Bearer "'],
      [`bearer ${SECRET}`, 'lowercase scheme'],
      [`Bearer ${SECRET}x`, 'secret + 1 char'],
      [`Bearer ${SECRET.slice(0, -1)}`, 'secret - 1 char'],
      [`Bearer ${'x'.repeat(SECRET.length)}`, 'same length, wrong value'],
    ]
    for (const [h, label] of cases) {
      const r = authorizeInternal(req(h))
      assertEq(r.ok ? 200 : r.status, 401, `${label} → 401`)
    }
  })

  await step('reconcile route refuses before touching the DB', async () => {
    // No Supabase credentials in a unit run: if the route got as far as a
    // query it would throw/500. A clean 401/503 proves it stopped at auth.
    process.env.INTERNAL_API_SECRET = SECRET
    assertEq((await reconcilePOST(req())).status, 401, 'no bearer → 401')
    assertEq((await reconcilePOST(req('Bearer nope'))).status, 401, 'wrong bearer → 401')
    delete process.env.INTERNAL_API_SECRET
    assertEq((await reconcilePOST(req(`Bearer ${SECRET}`))).status, 503, 'secret unset on the deployment → 503')
    process.env.INTERNAL_API_SECRET = SECRET
  })

  await step('window: 10 min – 48 h', async () => {
    const rows = [
      row('order', 1, 2),            // too new
      row('order', 2, 9.9),          // too new (just)
      row('order', 3, 10.1),         // in
      row('reservation', 1, 60),     // in
      row('broadcast', 1, 47 * 60),  // in
      row('promotion', 1, 49 * 60),  // too old
    ]
    const { deps } = fakeDeps(rows)
    const { rows: picked, from, to } = await selectCandidates(deps)
    assertEq(picked.map(r => r.id).sort(), ['broadcast-1', 'order-3', 'reservation-1'], 'only rows 10min–48h old are picked')
    assertEq(to, new Date(NOW - RECONCILE_MIN_AGE_MS).toISOString(), 'window upper bound = now - 10min')
    assertEq(from, new Date(NOW - RECONCILE_MAX_AGE_MS).toISOString(), 'window lower bound = now - 48h')
  })

  await step('cap + newest first across all four tables', async () => {
    const rows: PendingDeposit[] = []
    let n = 0
    for (const kind of ['order', 'reservation', 'broadcast', 'promotion'] as const) {
      for (let i = 0; i < 20; i++) rows.push(row(kind, n++, 11 + n))   // 80 rows, distinct ages
    }
    const { deps } = fakeDeps(rows)
    const { rows: picked } = await selectCandidates(deps)
    assertEq(picked.length, RECONCILE_MAX_PER_RUN, `capped at ${RECONCILE_MAX_PER_RUN}`)
    assertEq(RECONCILE_MAX_PER_RUN, 25, 'cap is 25')
    const newest25 = rows.slice().sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 25).map(r => r.id)
    assertEq(picked.map(r => r.id), newest25, 'the 25 newest, newest first')
    assert(new Set(picked.map(r => r.kind)).size > 1, 'mixes tables rather than exhausting one')
  })

  await step('run: settles by PawaPay answer, isolates failures', async () => {
    const rows = [row('order', 1, 15), row('order', 2, 16), row('reservation', 1, 17), row('broadcast', 1, 18), row('promotion', 1, 19), row('order', 3, 20)]
    const answers = {
      'dep-order-1': 'COMPLETED', 'dep-order-2': 'FAILED', 'dep-reservation-1': 'SUBMITTED',
      'dep-broadcast-1': 'SETTLED_ELSEWHERE', 'dep-promotion-1': 'REJECTED',
    }
    const { deps, settled } = fakeDeps(rows, answers, { throwOn: 'dep-order-3', stale: 2 })
    const s = await runReconcile(deps)
    assertEq(s.checked, 6, 'checked all 6')
    assertEq(s.paid, 1, '1 paid')
    assertEq(s.failed, 2, '2 failed (FAILED + REJECTED)')
    assertEq(s.still_pending, 1, '1 still pending (non-final answer)')
    assertEq(s.already_settled, 1, '1 already settled by someone else')
    assertEq(s.errors, 1, 'PawaPay error on one row is counted, not fatal')
    assert(!settled.includes('dep-order-3'), 'the errored row is not settled')
    assertEq(settled.length, 5, 'every other row reached settle')
    assertEq(s.stale_over_48h, 2, 'stale (>48h) pending rows are counted for manual review')
  })

  await step('run: bounded concurrency', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row('order', i, 11 + i))
    const f = fakeDeps(rows)
    await runReconcile(f.deps)
    assert(f.maxInFlight() <= RECONCILE_CONCURRENCY, `at most ${RECONCILE_CONCURRENCY} PawaPay calls in flight (saw ${f.maxInFlight()})`)
    assert(f.maxInFlight() > 1, 'but more than one (actually parallel)')
  })

  await step('run: nothing to do', async () => {
    const s = await runReconcile(fakeDeps([]).deps)
    assertEq(s.checked, 0, 'empty window → checks nothing')
  })

  if (originalSecret === undefined) delete process.env.INTERNAL_API_SECRET
  else process.env.INTERNAL_API_SECRET = originalSecret
  finish(SUITE)
}

main()
