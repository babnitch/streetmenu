// Reads that add the photo focus columns (lib/photoFocus.ts) when the
// database has them, and fall back to the same read without them when it
// doesn't yet (before supabase-photo-focus.sql: column missing 42703, or not
// granted to the public key 42501). Remembered per table, per page load /
// server instance. Works with the browser client and supabaseAdmin.

import { PHOTO_FOCUS_COLUMNS as FOCUS_COLUMNS } from '@/lib/publicColumns'

type Table = keyof typeof FOCUS_COLUMNS
interface Result { error: { code?: string; message?: string } | null }

const known: Partial<Record<Table, boolean>> = {}
const MISSING = new Set(['42703', '42501', 'PGRST204'])

/** `run(on)` runs the query with (on) or without the focus columns — for a
 *  query that places them itself (e.g. inside an embedded relation). */
export async function selectWithFocusFlag<R extends Result>(table: Table, run: (on: boolean) => PromiseLike<R>): Promise<R> {
  if (known[table] !== false) {
    const r = await run(true)
    if (!r.error) { known[table] = true; return r }
    if (!MISSING.has(String(r.error.code ?? ''))) return r
    known[table] = false
  }
  return run(false)
}

/** `run(cols)` runs the query with these columns; `base` is the usual list. */
export function selectWithFocus<R extends Result>(table: Table, base: string, run: (cols: string) => PromiseLike<R>): Promise<R> {
  return selectWithFocusFlag(table, on => run(on ? `${base}, ${FOCUS_COLUMNS[table].join(', ')}` : base))
}

/** ", image_focus, logo_focus" when on, else "" — for embedded selects. */
export const focusCols = (table: Table, on: boolean): string => (on ? `, ${FOCUS_COLUMNS[table].join(', ')}` : '')

/** Server: are the focus columns there (for writes)? Checked once a minute. */
let checkedAt = 0
let ready: boolean | null = null
export async function focusColumnsReady(sb: { from: (t: string) => { select: (c: string) => { limit: (n: number) => PromiseLike<Result> } } }): Promise<boolean> {
  if (ready !== null && Date.now() - checkedAt < 60_000) return ready
  const [a, b] = await Promise.all([
    sb.from('restaurants').select(FOCUS_COLUMNS.restaurants.join(', ')).limit(1),
    sb.from('events').select(FOCUS_COLUMNS.events.join(', ')).limit(1),
  ])
  ready = !a.error && !b.error
  checkedAt = Date.now()
  return ready
}
