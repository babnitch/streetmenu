// What the PUBLIC key (the one in every page's JavaScript) can reach,
// checked against the database itself (supabase-public-reads.sql).
//
//   - orders: 0 rows, and no column at all;
//   - restaurants: only active rows, only lib/publicColumns.ts columns; each
//     server-only column (owner, reasons, payout numbers…) is refused;
//   - events: same, with the event lists;
//   - every other table except the public-by-design ones: no rows;
//   - no table accepts a write, no database function runs.
//
// The public grants and policies are "TO anon, authenticated" (old Supabase
// Auth sessions in browsers use the authenticated role and must still see
// the public pages): same columns, same rows, so checking the public key
// checks both. The authenticated role can't be signed in from here (no
// Supabase Auth users, no project JWT secret); the SQL check query and the
// file supabase-public-reads.sql pin it.
//
// Read-only. The write probes are UPDATEs on an id that cannot exist and
// function calls with a zero id: refused before running (42501) — and even
// if a door were open, they would match nothing.

import { sb, getAnon } from '../testkit/env'
import { assert, assertEq, warn, step, finish } from '../testkit/assert'
import {
  PUBLIC_RESTAURANT_COLUMNS, PRIVATE_RESTAURANT_COLUMNS, PUBLIC_RESTAURANT_SELECT,
  PUBLIC_EVENT_COLUMNS, PRIVATE_EVENT_COLUMNS, PUBLIC_EVENT_SELECT, ORDERS_PAUSE_COLUMNS,
} from '@/lib/publicColumns'

const SUITE = 'db-public-key-reads'
const NO_ID = '00000000-0000-0000-0000-000000000000'
const DENIED = '42501'

/** Tables the public key may read on purpose (rows filtered by policy). */
const PUBLIC_TABLES = ['restaurants', 'events', 'menu_items', 'restaurant_hours', 'event_ticket_tiers', 'broadcast_pricing', 'promotion_pricing', 'ref_values']

async function allTables(): Promise<string[]> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const r = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' },
  })
  const spec = await r.json() as { paths?: Record<string, unknown> }
  return Object.keys(spec.paths ?? {}).filter(p => p !== '/' && !p.startsWith('/rpc/')).map(p => p.slice(1)).sort()
}

async function main(): Promise<void> {
  const anon = getAnon()
  try {
    await step('orders: nothing at all', async () => {
      const { count: total } = await sb.from('orders').select('id', { count: 'exact', head: true })
      assert((total ?? 0) > 0, `the database has orders to hide (${total})`)
      const a = await anon.from('orders').select('id')
      assert(!!a.error || (a.data ?? []).length === 0, `0 orders (${a.error?.code ?? (a.data ?? []).length})`)
      for (const col of ['customer_name', 'customer_phone', 'delivery_address', 'items']) {
        const c = await anon.from('orders').select(col).limit(1)
        assertEq(c.error?.code, DENIED, `orders.${col} refused`)
      }
    })

    await step('restaurants: active rows, public columns only', async () => {
      const a = await anon.from('restaurants').select(PUBLIC_RESTAURANT_SELECT)
      assert(!a.error, `public columns readable (${a.error?.message ?? 'ok'})`)
      const { count: active } = await sb.from('restaurants').select('id', { count: 'exact', head: true })
        .eq('is_active', true).in('status', ['active', 'approved']).is('deleted_at', null)
      assertEq((a.data ?? []).length, active, 'only active, approved, not deleted')
      const star = await anon.from('restaurants').select('*').limit(1)
      assertEq(star.error?.code, DENIED, "select('*') refused (private columns exist)")
      const leaks: string[] = []
      for (const col of PRIVATE_RESTAURANT_COLUMNS) {
        const c = await anon.from('restaurants').select(col).limit(1)
        if (c.error?.code !== DENIED) leaks.push(col)
      }
      assertEq(leaks, [], `${PRIVATE_RESTAURANT_COLUMNS.length} server-only columns refused`)
      assert(PUBLIC_RESTAURANT_COLUMNS.length > 30, 'public list intact')
    })

    await step('restaurants: the orders-pause columns are public', async () => {
      const cols = ORDERS_PAUSE_COLUMNS.join(', ')
      const { error: missing } = await sb.from('restaurants').select(cols).limit(1)
      if (missing) { warn('orders pause columns missing', 'run supabase-orders-pause.sql'); return }
      const a = await anon.from('restaurants').select(`id, ${cols}`).limit(1)
      assert(!a.error, `${cols} readable (${a.error?.message ?? 'ok'})`)
    })

    await step('events: active rows, public columns only', async () => {
      const a = await anon.from('events').select(PUBLIC_EVENT_SELECT)
      assert(!a.error, `public columns readable (${a.error?.message ?? 'ok'})`)
      const { count: active } = await sb.from('events').select('id', { count: 'exact', head: true }).eq('is_active', true)
      assertEq((a.data ?? []).length, active, 'only active events')
      const leaks: string[] = []
      for (const col of PRIVATE_EVENT_COLUMNS) {
        const c = await anon.from('events').select(col).limit(1)
        if (c.error?.code !== DENIED) leaks.push(col)
      }
      assertEq(leaks, [], `${PRIVATE_EVENT_COLUMNS.length} server-only columns refused`)
      assert(PUBLIC_EVENT_COLUMNS.length > 30, 'public list intact')
    })

    const tables = await allTables()
    await step('every other table: no rows for the public key', async () => {
      assert(tables.length > 40, `${tables.length} tables listed`)
      const open: string[] = []
      for (const t of tables.filter(x => !PUBLIC_TABLES.includes(x))) {
        const { data, error } = await anon.from(t).select('*').limit(1)
        if (!error && (data ?? []).length > 0) open.push(t)
      }
      assertEq(open, [], 'no private table readable')
    })

    await step('no table accepts a write from the public key', async () => {
      const open: string[] = []
      for (const t of tables) {
        const { error: hasId } = await sb.from(t).select('id').limit(1)
        if (hasId) continue
        const { error } = await anon.from(t).update({ id: NO_ID } as never).eq('id', NO_ID)
        if (error?.code !== DENIED) open.push(t)
      }
      assertEq(open, [], 'every write refused')
    })

    await step('no database function runs with the public key', async () => {
      const probes: Array<[string, Record<string, unknown>]> = [
        ['delete_customer_cascade', { p_customer_id: NO_ID }],
        ['link_restaurant_to_customer', { p_restaurant_id: NO_ID, p_customer_id: NO_ID }],
        ['platform_setting_int', { p_key: '__none__', p_default: 0 }],
        ['event_availability', { p_event_id: NO_ID }],
      ]
      for (const [fn, args] of probes) {
        const { error } = await anon.rpc(fn, args)
        assertEq(error?.code, DENIED, `${fn} refused`)
      }
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  }
  finish(SUITE)
}

void main()
