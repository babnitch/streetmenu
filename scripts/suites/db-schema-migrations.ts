// TEST-PLAN.md §1b #18-#21 — schema/migration smoke plus the DB-level
// behaviours that no HTTP suite can see.
//
// This is the highest-value post-deploy check in the plan: it answers "did
// every migration actually land on THIS environment?" A missing column here
// is a real finding, not a skip — the suite fails, loudly, naming the column.
//
// Introspection note. PostgREST does not expose information_schema
// (`information_schema.columns` → PGRST205), so the read-only equivalent is
// to ask the API for the column or table and read the error code back:
//
//   missing column → 42703   ("column X does not exist")
//   missing table  → PGRST205 ("Could not find the table … in the schema cache")
//
// Both are pure SELECTs. They write nothing and cannot leave residue.
//
// One trap worth recording: `.select('*', { head: true, count: 'exact' })`
// does NOT error on a missing table — it returns count=null and no error, so
// a nonexistent table reads as "fine". Every probe below therefore uses a
// non-head select. Only #19's status-value checks and #20/#21 write anything,
// and those go through the fixtures so the ledger owns the cleanup.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { makeCustomer, makeRestaurant, type TestCustomer } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { generateReservationCodes } from '@/lib/reservationCode'

const SUITE = 'db-schema-migrations'

// ── Read-only schema probes ─────────────────────────────────────────────────

/** True when `table.column` exists. Missing column surfaces as 42703. */
async function columnExists(table: string, column: string): Promise<{ ok: boolean; detail: string }> {
  const { error } = await sb.from(table).select(column).limit(1)
  if (!error) return { ok: true, detail: 'present' }
  if (error.code === '42703') return { ok: false, detail: `MISSING — ${error.message}` }
  // Anything else (table absent, permission) is also a failure, but say which.
  return { ok: false, detail: `unexpected ${error.code}: ${error.message}` }
}

/** True when `table` exists. Missing table surfaces as PGRST205. */
async function tableExists(table: string): Promise<{ ok: boolean; detail: string }> {
  const { error } = await sb.from(table).select('*').limit(1)
  if (!error) return { ok: true, detail: 'present' }
  if (error.code === 'PGRST205') return { ok: false, detail: `MISSING — ${error.message}` }
  return { ok: false, detail: `unexpected ${error.code}: ${error.message}` }
}

/**
 * Whether orders.status accepts a value. A CHECK constraint or enum can only
 * be probed by attempting the write, so this inserts and tracks the row; the
 * ledger deletes it either way.
 */
async function orderStatusAccepted(
  restaurantId: string,
  customer: TestCustomer,
  status: string,
): Promise<{ ok: boolean; detail: string }> {
  const { data, error } = await sb.from('orders').insert({
    restaurant_id:  restaurantId,
    customer_id:    customer.id,
    customer_name:  customer.name,
    customer_phone: customer.phone,
    items:          [{ name: 'Probe', quantity: 1, price: 100 }],
    total_price:    100,
    status,
  } as never).select('id').single()

  if (error) return { ok: false, detail: `rejected — ${error.message}` }
  track('orders', (data as unknown as { id: string }).id)
  return { ok: true, detail: 'accepted' }
}

async function main(): Promise<void> {
  try {
    // ── Probe self-check ───────────────────────────────────────────────────
    // A schema suite that cannot detect absence is worse than no suite: it
    // would report a pre-migration environment as fully migrated. Prove both
    // probes fail on something known not to exist before trusting them below.
    await step('the probes actually detect absence', async () => {
      const missingCol = await columnExists('restaurants', '__t_no_such_column__')
      assert(!missingCol.ok, 'columnExists reports a nonexistent column as missing', missingCol.detail)
      assert(missingCol.detail.startsWith('MISSING'), 'and identifies it as 42703, not some other error')

      const missingTable = await tableExists('__t_no_such_table__')
      assert(!missingTable.ok, 'tableExists reports a nonexistent table as missing', missingTable.detail)
      assert(missingTable.detail.startsWith('MISSING'), 'and identifies it as PGRST205, not some other error')

      // The trap this suite is written around: with head:true a missing table
      // returns count=null and NO error, so the same check written the obvious
      // way would silently pass. Pinning it so nobody "simplifies" it back.
      const { error: headErr } = await sb.from('__t_no_such_table__')
        .select('*', { head: true, count: 'exact' })
      assert(headErr === null,
        'head:true select on a missing table returns no error — why the probes avoid it')
    })

    // ── #19 migration smoke: tables ────────────────────────────────────────
    await step('#19 tables added by migrations exist', async () => {
      const tables: Array<[string, string]> = [
        ['message_log',         'supabase-message-log.sql'],
        ['event_subscriptions', 'supabase-subscriptions.sql'],
        ['event_ticket_tiers',  'ticket tiers'],
        ['restaurant_team',     'team roles'],
        ['team_invitations',    'team invitations'],
      ]
      for (const [table, origin] of tables) {
        const r = await tableExists(table)
        assert(r.ok, `${table} exists (${origin})`, r.detail)
      }
    })

    // ── #19 migration smoke: columns ───────────────────────────────────────
    await step('#19 columns added by migrations exist', async () => {
      const columns: Array<[string, string, string]> = [
        ['restaurants',        'prep_time_min',            'supabase-prep-time.sql'],
        ['restaurants',        'prep_time_max',            'supabase-prep-time.sql'],
        ['customers',          'notification_channel',     'supabase-notification-channel.sql'],
        ['restaurants',        'payment_mode',             'supabase-payment-modes.sql'],
        ['events',             'payment_mode',             'supabase-payment-modes.sql'],
        ['restaurants',        'whatsapp_payment_enabled', 'supabase-payment-modes.sql'],
        ['events',             'whatsapp_payment_enabled', 'supabase-payment-modes.sql'],
        ['event_reservations', 'reservation_code',         'reservation codes'],
      ]
      for (const [table, column, origin] of columns) {
        const r = await columnExists(table, column)
        assert(r.ok, `${table}.${column} exists (${origin})`, r.detail)
      }
    })

    // Fixtures shared by the write-touching checks below.
    const owner    = await makeCustomer({ suiteNo: 19, name: 'Schema Owner' })
    const buyer    = await makeCustomer({ suiteNo: 19, name: 'Schema Buyer' })
    const rest     = await makeRestaurant({ ownerId: owner.id, label: 'schema_probe', whatsapp: owner.phone })

    // ── #19 migration smoke: orders.status values ──────────────────────────
    await step('#19 orders.status accepts the migration-added values', async () => {
      // Baseline: a value that predates the migration, so a failure here means
      // the probe itself is broken rather than the migration being absent.
      const pending = await orderStatusAccepted(rest.id, buyer, 'pending')
      assert(pending.ok, "orders.status accepts 'pending' (probe sanity check)", pending.detail)

      for (const status of ['cancelled', 'delivered']) {
        const r = await orderStatusAccepted(rest.id, buyer, status)
        assert(r.ok, `orders.status accepts '${status}' (supabase-orders-cancelled-status.sql)`, r.detail)
      }
    })

    // ── #18 generateReservationCodes ───────────────────────────────────────
    await step('#18 generateReservationCodes returns n distinct, unused codes', async () => {
      const N = 8
      const codes = await generateReservationCodes(N)
      assertEq(codes.length, N, `returns exactly ${N} codes`)
      assertEq(new Set(codes).size, N, 'all codes are distinct from each other')

      const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      assert(codes.every(c => c.length >= 4), 'every code is at least 4 characters')
      assert(codes.every(c => c.split('').every(ch => ALPHABET.includes(ch))),
        'every character comes from the unambiguous alphabet')

      // None may collide with a code already in the table — that is the whole
      // point of the DB pre-check inside generateReservationCode().
      const { data, error } = await sb.from('event_reservations')
        .select('reservation_code').in('reservation_code', codes)
      assert(!error, `existing-code lookup succeeded${error ? ` — ${error.message}` : ''}`)
      assertEq((data ?? []).length, 0, 'none of the generated codes already exists in event_reservations')
    })

    // ── #20 restaurant_team owner trigger ──────────────────────────────────
    await step('#20 inserting a restaurant with customer_id auto-creates the owner team row', async () => {
      const triggerOwner = await makeCustomer({ suiteNo: 20, name: 'Trigger Owner' })
      // makeRestaurant inserts the restaurant and then only READS restaurant_team
      // (to track whatever the trigger made). It never inserts a team row, so
      // anything found here came from the trigger.
      const triggered = await makeRestaurant({
        ownerId: triggerOwner.id, label: 'trigger_probe', whatsapp: triggerOwner.phone,
      })

      const { data, error } = await sb.from('restaurant_team')
        .select('id, role, status, customer_id')
        .eq('restaurant_id', triggered.id)
      assert(!error, `restaurant_team readable${error ? ` — ${error.message}` : ''}`)

      const rows = (data ?? []) as Array<{ role: string; status: string; customer_id: string }>
      assertEq(rows.length, 1, 'exactly one team row was created automatically')
      assertEq(rows[0]?.role, 'owner', "the auto-created row has role='owner'")
      assertEq(rows[0]?.status, 'active', "the auto-created row is active")
      assertEq(rows[0]?.customer_id, triggerOwner.id, 'it points at restaurants.customer_id')
    })

    // ── #21 soft-delete semantics ──────────────────────────────────────────
    await step('#21 soft-deleted restaurants are excluded from the public read', async () => {
      const alive           = await makeRestaurant({ ownerId: owner.id, label: 'sd_alive',   whatsapp: owner.phone })
      const deletedByColumn = await makeRestaurant({ ownerId: owner.id, label: 'sd_deleted', whatsapp: owner.phone,
                                                     extra: { deleted_at: new Date().toISOString() } })
      const deletedByStatus = await makeRestaurant({ ownerId: owner.id, label: 'sd_status',  whatsapp: owner.phone,
                                                     extra: { status: 'deleted' } })

      // The exact filter the public feed uses — app/page.tsx:206-209.
      const { data, error } = await sb.from('restaurants')
        .select('id')
        .eq('is_active', true)
        .in('status', ['active', 'approved'])
        .is('deleted_at', null)
        .in('id', [alive.id, deletedByColumn.id, deletedByStatus.id])
      assert(!error, `public-shaped read succeeded${error ? ` — ${error.message}` : ''}`)

      const ids = ((data ?? []) as Array<{ id: string }>).map(r => r.id)
      assert(ids.includes(alive.id), 'a live restaurant is returned')
      assert(!ids.includes(deletedByColumn.id), 'deleted_at set → excluded')
      assert(!ids.includes(deletedByStatus.id), "status='deleted' → excluded")

      // Both markers are genuinely still in the table — the rows are soft
      // deleted, not gone. If they had been hard-deleted the exclusion above
      // would pass for the wrong reason.
      const { data: raw } = await sb.from('restaurants')
        .select('id').in('id', [deletedByColumn.id, deletedByStatus.id])
      assertEq((raw ?? []).length, 2, 'both soft-deleted rows still exist in the table')
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
