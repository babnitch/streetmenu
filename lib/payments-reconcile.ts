// Payment reconcile — the safety net for deposits whose callback never
// landed (dropped, or rejected once signatures are enforced).
//
// Most checkouts poll /api/payments/status, which settles a deposit even
// without its callback. WhatsApp orders and reservations are polled by
// NOTHING, so for them the webhook was the only way a payment got recorded.
// This job closes that gap for every deposit type: find deposits still
// pending, ask PawaPay (server-to-server), and settle through the same
// settleDeposit() as the webhook and the poll — atomic claim, so it can never
// double-settle against them.
//
// Triggered every ~10 min by Supabase pg_cron → pg_net → POST
// /api/payments/reconcile (Bearer INTERNAL_API_SECRET).
//
// Window: pending for at least MIN_AGE (deposits still in flight are left to
// the webhook/poll — though a non-final answer writes nothing anyway, so the
// floor only saves PawaPay calls) and at most MAX_AGE (PawaPay answers
// ACCEPTED for a deposit it has never seen, so a deposit that never reached
// them would otherwise be re-checked forever). Older ones are counted and
// logged for a human.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { checkDepositStatus, type DepositStatus } from '@/lib/pawapay'
import { settleDeposit, type SettleKind, type SettleResult } from '@/lib/payments-settle'

export const RECONCILE_MIN_AGE_MS = 10 * 60 * 1000
export const RECONCILE_MAX_AGE_MS = 48 * 60 * 60 * 1000
export const RECONCILE_MAX_PER_RUN = 25
export const RECONCILE_CONCURRENCY = 5

// Which timestamp says "when did this deposit start" per table. orders has an
// updated_at trigger, so writing payment_id (WhatsApp pays an existing order)
// bumps it; the other three create the row and the deposit in one request.
export const RECONCILE_SOURCES: ReadonlyArray<{ kind: SettleKind; table: string; timeColumn: string }> = [
  { kind: 'order',       table: 'orders',             timeColumn: 'updated_at' },
  { kind: 'reservation', table: 'event_reservations', timeColumn: 'updated_at' },
  { kind: 'broadcast',   table: 'broadcasts',         timeColumn: 'created_at' },
  { kind: 'promotion',   table: 'promotions',         timeColumn: 'updated_at' },
]

export interface PendingDeposit { kind: SettleKind; id: string; depositId: string; at: string }

export interface ReconcileDeps {
  // Pending rows with a payment_id whose timeColumn is in [from, to], newest first.
  fetchPending: (src: typeof RECONCILE_SOURCES[number], fromISO: string, toISO: string, limit: number) => Promise<PendingDeposit[]>
  // Count of pending rows older than the window (for the "review manually" log).
  countStale:   (src: typeof RECONCILE_SOURCES[number], beforeISO: string) => Promise<number>
  checkStatus:  (depositId: string) => Promise<DepositStatus>
  settle:       (depositId: string, outcome: DepositStatus) => Promise<SettleResult>
  now:          () => number
}

export interface ReconcileSummary {
  checked:       number
  paid:          number
  failed:        number
  still_pending: number
  already_settled: number
  errors:        number
  stale_over_48h: number
  window:        { from: string; to: string }
}

// Newest first across all four tables, capped. Newest first because a
// customer who paid minutes ago is the one most likely still waiting.
export async function selectCandidates(deps: ReconcileDeps): Promise<{ rows: PendingDeposit[]; from: string; to: string }> {
  const now = deps.now()
  const from = new Date(now - RECONCILE_MAX_AGE_MS).toISOString()
  const to   = new Date(now - RECONCILE_MIN_AGE_MS).toISOString()
  const perTable = await Promise.all(RECONCILE_SOURCES.map(src => deps.fetchPending(src, from, to, RECONCILE_MAX_PER_RUN)))
  const rows = perTable.flat()
    .filter(r => r.at >= from && r.at <= to && !!r.depositId)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, RECONCILE_MAX_PER_RUN)
  return { rows, from, to }
}

export async function runReconcile(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const { rows, from, to } = await selectCandidates(deps)
  const summary: ReconcileSummary = {
    checked: 0, paid: 0, failed: 0, still_pending: 0, already_settled: 0, errors: 0, stale_over_48h: 0,
    window: { from, to },
  }

  // Small fixed pool: PawaPay is called once per row, and one bad row must
  // not stop the others.
  let next = 0
  async function worker() {
    while (next < rows.length) {
      const row = rows[next++]
      summary.checked++
      try {
        const info = await deps.checkStatus(row.depositId)
        const result = await deps.settle(row.depositId, info)
        const action = result.kind === 'unknown' ? 'unknown' : result.action
        if (action === 'paid') summary.paid++
        else if (action === 'failed') summary.failed++
        else if (action === 'already_settled') summary.already_settled++
        else summary.still_pending++
        if (action === 'paid' || action === 'failed') {
          console.log(`[reconcile] RECOVERED ${row.kind}=${row.id} deposit=${row.depositId} → ${action} (pawapay=${info.status})`)
        }
      } catch (e) {
        summary.errors++
        console.error(`[reconcile] ${row.kind}=${row.id} deposit=${row.depositId} failed: ${(e as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, rows.length) }, worker))

  const stale = await Promise.all(RECONCILE_SOURCES.map(src => deps.countStale(src, from)))
  summary.stale_over_48h = stale.reduce((a, b) => a + b, 0)
  if (summary.stale_over_48h > 0) {
    console.warn(`[reconcile] ${summary.stale_over_48h} deposit(s) pending for over 48h — outside the auto-reconcile window, review manually`)
  }
  console.log(`[reconcile] done: ${JSON.stringify(summary)}`)
  return summary
}

// Production wiring.
export const liveReconcileDeps: ReconcileDeps = {
  async fetchPending(src, fromISO, toISO, limit) {
    const { data, error } = await supabaseAdmin
      .from(src.table)
      .select(`id, payment_id, ${src.timeColumn}`)
      .eq('payment_status', 'pending')
      .not('payment_id', 'is', null)
      .gte(src.timeColumn, fromISO)
      .lte(src.timeColumn, toISO)
      .order(src.timeColumn, { ascending: false })
      .limit(limit)
    if (error) throw new Error(`[reconcile] ${src.table} query failed: ${error.message}`)
    return ((data ?? []) as unknown as Array<Record<string, string>>).map(r => ({
      kind: src.kind, id: r.id, depositId: r.payment_id, at: new Date(r[src.timeColumn]).toISOString(),
    }))
  },
  async countStale(src, beforeISO) {
    const { count } = await supabaseAdmin
      .from(src.table)
      .select('id', { count: 'exact', head: true })
      .eq('payment_status', 'pending')
      .not('payment_id', 'is', null)
      .lt(src.timeColumn, beforeISO)
    return count ?? 0
  },
  checkStatus: checkDepositStatus,
  settle:      (depositId, outcome) => settleDeposit(depositId, outcome, 'reconcile'),
  now:         () => Date.now(),
}
