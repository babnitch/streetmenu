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

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { sb, anonSb } from '../testkit/env'
import { assert, assertEq, step, warn, finish } from '../testkit/assert'
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


// ── RLS EXPECTED-STATE REGISTER (Phase 0 of the anon-read fix) ──────────────
//
// WHAT THIS MEASURES. pg_policies is unreadable from here — PostgREST does
// not expose pg_catalog and there is no DATABASE_URL to go around it. So the
// policy is measured by its EFFECT: what the anon (browser) client can read
// versus what the service-role client can read. That is arguably the better
// test anyway — it checks what a stranger holding the public key can actually
// pull, not the policy text that is meant to stop them.
//
//   locked      anon reads 0 while service-role reads > 0
//   restricted  anon reads FEWER rows than service-role, but more than none
//   open        anon reads exactly what service-role reads
//   empty       service-role reads 0 — the table cannot be classified at all
//
// WHY A REGISTER RATHER THAN PLAIN ASSERTIONS. Three of these tables were
// WRONG when this was written (orders, customers, restaurants — the anon-read
// PII leak). customers closed in Phase 1 and is now a hard assertion; orders
// and restaurants stay wrong until Phases 2 and 3a land. Asserting the target
// state outright would
// leave test:release permanently red, which destroys the gate: once red is
// normal, nobody reads it. Warning on all of them instead has the opposite
// failure — a warning nobody is forced to act on rots quietly, and the leak
// outlives the person who found it.
//
// So each table declares BOTH states, and the three-way comparison below has
// no comfortable middle:
//
//   measured === target                   → hard PASS. The guarantee is live
//                                           and any regression fails the gate.
//   measured === current ≠ target         → WARN, marked EXPECTED-RED, naming
//                                           the phase that closes it.
//   measured === target ≠ current         → hard FAIL. The phase LANDED and
//                                           this entry was not promoted. One
//                                           line to fix (set current: target),
//                                           and the assertion becomes real.
//   measured is neither                   → hard FAIL. Something moved that
//                                           nobody predicted — a partial
//                                           policy, or a regression.
//
// The third case is the point. A closed gap that nobody promotes turns the
// suite red, so "red is normal" cannot set in: the only two stable states are
// "gap still open, warned, phase named" and "gap closed, promoted, asserted".
// Sitting between them is a failure by construction.
//
// TO PROMOTE an entry when its phase lands: change `current` to match
// `target` and delete the `phase` note. Nothing else.

type RlsState = 'locked' | 'restricted' | 'open' | 'empty'

interface RlsExpectation {
  table:   string
  /** What the state IS today. Equal to `target` once the gap is closed. */
  current: RlsState
  /** What it MUST become. */
  target:  RlsState
  /** Why the target is what it is — read this before changing one. */
  why:     string
  /** Phase that closes the gap. Absent when there is no gap. */
  phase?:  string
}

const RLS_EXPECTATIONS: RlsExpectation[] = [
  // ── Already correct. These are the ones with real protective value today:
  //    each is a hard assertion, so a migration that OPENS one fails the gate.
  { table: 'order_items',        current: 'locked', target: 'locked',
    why: 'order line items — belongs to one customer, no public read' },
  { table: 'restaurant_team',    current: 'locked', target: 'locked',
    why: 'who staffs a restaurant, with customer_id — never public' },
  { table: 'audit_log',          current: 'locked', target: 'locked',
    why: 'moderation trail; naming the actor is the point of it' },
  { table: 'verification_codes', current: 'locked', target: 'locked',
    why: 'login OTPs — an anon read here is account takeover' },
  { table: 'customer_vouchers',  current: 'locked', target: 'locked',
    why: 'a named customer’s vouchers and their redemption state' },

  // ── The leak. EXPECTED-RED until the phase named on each lands.
  { table: 'orders',    current: 'open', target: 'locked', phase: 'Phase 2',
    why: 'customer_name, customer_phone, manual_payment_phone, items, totals, '
       + 'payment ids. No public read exists or should; the two browser readers '
       + '(admin Orders panel, vendor dashboard) move to authenticated routes first' },
  { table: 'customers', current: 'locked', target: 'locked',
    why: 'name, phone, momo_phone, suspension_reason. Locked in Phase 1 '
       + '(supabase-customers-rls-lock.sql). The FK join that used to reach '
       + 'this table from the browser — the admin Restaurants owner block — '
       + 'reads GET /api/admin/restaurants instead. Anything that re-adds an '
       + 'anon read of customers, directly or through a join, fails here' },
  { table: 'restaurants', current: 'open', target: 'restricted', phase: 'Phase 3a',
    why: 'RESTRICTED, never locked: the home feed, search, detail page, checkout '
       + 'and promo banner are legitimately anon reads. But anon must not see '
       + 'suspended / pending / soft-deleted rows, which public_active_read excludes' },

  // ── Public by design. Asserted so an over-eager lock is caught too — the
  //    failure mode of this whole project is locking one table too many and
  //    blanking the customer-facing app.
  { table: 'menu_items',       current: 'open', target: 'open',
    why: 'the public menu on every restaurant page' },
  { table: 'restaurant_hours', current: 'open', target: 'open',
    why: 'opening hours, rendered publicly and used by open-status' },
]

/**
 * Measure a table's effective anon read state.
 *
 * An anon ERROR counts as locked: a policy denial can surface either as an
 * empty result or as a PostgREST error depending on the table, and both mean
 * the same thing to a visitor.
 *
 * head:true is safe here, unlike the schema probes above — those needed to
 * detect a MISSING table, which head:true cannot do. Here the service-role
 * count establishes the table exists and how many rows it holds before the
 * anon number is interpreted at all.
 */
async function rlsState(table: string): Promise<{
  state: RlsState; anon: number | null; service: number | null; detail: string
}> {
  const s = await sb.from(table).select('*', { count: 'exact', head: true })
  if (s.error) {
    return { state: 'empty', anon: null, service: null,
             detail: `service-role could not read it — ${s.error.message}` }
  }
  const service = s.count ?? 0
  const a = await anonSb.from(table).select('*', { count: 'exact', head: true })
  const anon = a.error ? 0 : (a.count ?? 0)

  if (service === 0) {
    return { state: 'empty', anon, service,
             detail: 'table is empty — anon and service-role both read 0, so the policy cannot be classified' }
  }
  const state: RlsState = anon === 0 ? 'locked' : anon >= service ? 'open' : 'restricted'
  return { state, anon, service, detail: `anon ${anon} / service-role ${service}` }
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

    // ── signup_sessions.user_type: schema vs code ──────────────────────────
    // This guard exists because a SILENT failure killed two production flows.
    // The router wrote 'menu_category' and 'invite_accept'; the CHECK
    // constraint had never been widened for either; and none of the five
    // upserts checked its error. The 2-part menu add-item flow and the
    // invite-accept registration therefore did nothing at all, for months,
    // while still sending the user a friendly prompt.
    //
    // It FAILS HARD and is never a warn(). A warn is for a known-benign
    // environment gap; a red here means the schema and the code disagree and
    // some flow is dead. That is precisely the signal that was missing.
    // If this suite is red on an environment that has not yet run
    // supabase-signup-session-types.sql, the red is correct.
    await step('signup_sessions.user_type accepts every value the router writes', async () => {
      const holder = await makeCustomer({ suiteNo: 19, name: 'Session Type Probe' })

      // Attempt one row per value, cleaning between so the PK never collides.
      const tryType = async (userType: string): Promise<string | null> => {
        await sb.from('signup_sessions').delete().eq('phone', holder.phone)
        const { error } = await sb.from('signup_sessions').insert({
          phone:      holder.phone,
          user_type:  userType,
          step:       1,
          data:       {},
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        } as never)
        return error ? `${error.code}: ${error.message}` : null
      }

      // (a) The probe must be able to DETECT rejection, or it proves nothing —
      // same reasoning as the tableExists self-check above.
      const bogus = await tryType('__t_not_a_real_session_type__')
      assert(!!bogus, 'the probe rejects a nonsense user_type (so it can detect a rejection at all)')
      assert((bogus ?? '').startsWith('23514'),
        `and rejects it via the CHECK constraint, not some other error (got ${bogus})`)

      // (b) Every value the constraint is supposed to allow.
      const EXPECTED = [
        'customer', 'vendor', 'photo_update', 'restaurant_select',
        'ordering', 'menu_category', 'invite_accept',
      ]
      for (const t of EXPECTED) {
        const err = await tryType(t)
        assert(err === null, `signup_sessions.user_type accepts '${t}'`, err ?? undefined)
      }

      // (c) The part that catches the NEXT divergence: read what the router
      // actually writes and assert each literal is allowed. Adding an eighth
      // session type without a migration fails here, by name, instead of
      // dying silently in production.
      const routerSrc = readFileSync(
        resolve(process.cwd(), 'app/api/whatsapp/incoming/route.ts'), 'utf8')
      const written = Array.from(new Set(
        Array.from(routerSrc.matchAll(/user_type:\s*'([a-z_]+)'/g)).map(m => m[1]),
      )).sort()
      assert(written.length > 0, `found the router's user_type literals (${written.join(', ')})`)
      for (const t of written) {
        assert(EXPECTED.includes(t),
          `the router writes user_type '${t}' and the constraint allows it`,
          `'${t}' is written by app/api/whatsapp/incoming/route.ts but is NOT in the allowed set — ` +
          'widen signup_sessions_user_type_check with a migration, or the flow using it is silently dead')
      }

      await sb.from('signup_sessions').delete().eq('phone', holder.phone)
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

    // ── RLS effective-state register (Phase 0) ─────────────────────────────
    // Read-only. Counts only, never row contents — this suite must not print
    // the PII it exists to protect.
    await step('RLS: the anon client reads only what it is meant to', async () => {
      // Self-check first, exactly like the schema probes above. A measurement
      // that cannot tell locked from open would report the leak as fixed.
      // restaurant_team is locked and audit_log is locked while menu_items is
      // public, so a working probe MUST separate them; if it says both are the
      // same, the anon client is misconfigured (wrong key, or silently using
      // the service role) and every verdict below is worthless.
      const lockedProbe = await rlsState('restaurant_team')
      const openProbe   = await rlsState('menu_items')
      const canTell = lockedProbe.state === 'locked' && openProbe.state === 'open'
      assert(canTell,
        'the anon probe can distinguish a locked table from a public one',
        `restaurant_team=${lockedProbe.state} (${lockedProbe.detail}), menu_items=${openProbe.state} (${openProbe.detail})`)
      if (!canTell) {
        // Refusing to grade on a broken instrument. Without this, a
        // misconfigured anon key reads every table as locked and the whole
        // section turns green on the day the leak is at its worst.
        assert(false, 'RLS register SKIPPED — the probe is not trustworthy, see above')
        return
      }

      for (const e of RLS_EXPECTATIONS) {
        const m = await rlsState(e.table)
        const label = `${e.table}: ${e.target}`

        if (m.state === 'empty') {
          // Cannot classify an empty table either way. Never a pass: a green
          // tick here would claim a guarantee that was never measured.
          warn(`${label} — UNVERIFIABLE`, m.detail)
          continue
        }

        if (m.state === e.target && e.current === e.target) {
          // The guarantee is live and pinned. A policy change that opens this
          // table fails test:release.
          assert(true, `${label} — ${m.detail}`)
          continue
        }

        if (m.state === e.target && e.current !== e.target) {
          // The gap closed. Promote the entry so it becomes a hard assertion
          // instead of a warning nobody has to act on.
          assert(false,
            `${label} — ${e.phase ?? 'the phase'} IS COMPLETE: promote this entry`,
            `measured ${m.state} (${m.detail}); set current: '${e.target}' for '${e.table}' in RLS_EXPECTATIONS`)
          continue
        }

        if (m.state === e.current) {
          // Known gap, still open, phase named. Expected red — reported, not
          // scored, so the fast gate stays meaningful.
          warn(`${label} — EXPECTED-RED, currently ${m.state} (${m.detail})`,
            `closes in ${e.phase ?? 'a later phase'} — ${e.why}`)
          continue
        }

        // Neither the known-current nor the target state. Either a partial
        // policy change or a regression on a table that was correct.
        assert(false,
          `${label} — UNEXPECTED state '${m.state}'`,
          `expected '${e.current}' (today) or '${e.target}' (target); got ${m.detail}`)
      }
    })

    // ── RLS: the restaurants predicate, measured rather than assumed ────────
    await step('RLS: restricting restaurants would hide the rows it should', async () => {
      // Phase 3a applies public_active_read. This does not apply it — it
      // measures the gap that policy would close, so the number in the report
      // is a fact rather than a projection, and so the day it lands the
      // change in anon_count is already predicted here.
      const { count: anonNow } = await anonSb.from('restaurants')
        .select('*', { count: 'exact', head: true })
      const { count: wouldSee } = await sb.from('restaurants')
        .select('*', { count: 'exact', head: true })
        .eq('is_active', true).in('status', ['active', 'approved']).is('deleted_at', null)

      assert(typeof anonNow === 'number' && typeof wouldSee === 'number',
        'both counts read cleanly')
      const hidden = (anonNow ?? 0) - (wouldSee ?? 0)

      if (hidden > 0) {
        warn(`restaurants: EXPECTED-RED — anon can read ${hidden} row(s) public_active_read would hide`,
          `anon sees ${anonNow}, the predicate allows ${wouldSee} (suspended / pending / soft-deleted) — closes in Phase 3a`)
      } else {
        // Either the policy landed, or every row happens to be public right
        // now. The register entry above is what distinguishes those, so this
        // only confirms there is nothing left to hide.
        assert(hidden === 0,
          `restaurants: anon sees no row the public predicate excludes (${anonNow} = ${wouldSee})`)
      }
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
