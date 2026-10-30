// Server side of the reference data: reads ref_values (hidden values too —
// with the service role) and refreshes lib/refData's current lists. Cached
// 60 s per server instance; a failure keeps the last good lists (or the
// backup), so a page never breaks on it.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { setRefValues, allRefValues, type RefValue } from '@/lib/refData'

const TTL_MS = 60_000
let loadedAt = 0
let inflight: Promise<readonly RefValue[]> | null = null

export async function getRefData(force = false): Promise<readonly RefValue[]> {
  if (!force && Date.now() - loadedAt < TTL_MS) return allRefValues()
  inflight ??= (async () => {
    try {
      const { data, error } = await supabaseAdmin.from('ref_values')
        .select('kind, code, label_fr, label_en, icon, keywords, country, lat, lng, zoom, visible, sort_order')
      if (error) throw new Error(error.message)
      setRefValues(((data ?? []) as RefValue[]).map(r => ({ ...r, keywords: r.keywords ?? [] })))
      loadedAt = Date.now()
    } catch (e) {
      console.error('[refData] read failed, keeping the current lists:', (e as Error).message)
      loadedAt = Date.now() - TTL_MS + 10_000   // retry in 10 s
    } finally {
      inflight = null
    }
    return allRefValues()
  })()
  return inflight
}

/** After an admin write: the next read goes to the database. */
export function invalidateRefData(): void { loadedAt = 0 }
