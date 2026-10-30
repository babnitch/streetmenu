// Admin → Données de référence: checks for a value's fields, and how many
// items use each value ("utilisé par N"). Server only.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { matchesCuisineCategory, normalizeCuisine } from '@/lib/cuisineCategories'
import { REF_KINDS, type RefKind } from '@/lib/refData'

export interface RefRow {
  id: string; kind: RefKind; code: string; label_fr: string; label_en: string; icon: string | null; keywords: string[]
  country: string | null; lat: number | null; lng: number | null; zoom: number | null; visible: boolean; sort_order: number
}
export const REF_COLUMNS = 'id, kind, code, label_fr, label_en, icon, keywords, country, lat, lng, zoom, visible, sort_order'

export const isRefKind = (v: unknown): v is RefKind => (REF_KINDS as readonly string[]).includes(String(v))

type Fields = Partial<Pick<RefRow, 'label_fr' | 'label_en' | 'icon' | 'keywords' | 'country' | 'lat' | 'lng' | 'zoom' | 'visible' | 'sort_order'>>
export function checkFields(raw: Record<string, unknown>, kind: RefKind, create: boolean): { ok: true; fields: Fields } | { ok: false; error: string; field: string } {
  const f: Fields = {}
  const text = (k: 'label_fr' | 'label_en', max: number) => {
    if (!(k in raw)) return
    const v = typeof raw[k] === 'string' ? (raw[k] as string).trim().slice(0, max) : ''
    f[k] = v
  }
  text('label_fr', 60); text('label_en', 60)
  if (create || 'label_fr' in raw) if (!f.label_fr) return { ok: false, error: 'Libellé FR requis / FR label required', field: 'label_fr' }
  if (create || 'label_en' in raw) if (!f.label_en) return { ok: false, error: 'Libellé EN requis / EN label required', field: 'label_en' }
  if ('icon' in raw) f.icon = typeof raw.icon === 'string' && raw.icon.trim() ? raw.icon.trim().slice(0, 8) : null
  if ('keywords' in raw) {
    const list = Array.isArray(raw.keywords) ? raw.keywords : typeof raw.keywords === 'string' ? raw.keywords.split(',') : []
    f.keywords = Array.from(new Set(list.map(k => normalizeCuisine(String(k)).trim()).filter(k => k.length >= 2))).slice(0, 40)
  }
  if ('visible' in raw) f.visible = raw.visible === true
  if ('sort_order' in raw) { const n = Math.round(Number(raw.sort_order)); if (!Number.isFinite(n)) return { ok: false, error: 'Ordre invalide / Invalid order', field: 'sort_order' }; f.sort_order = n }
  if (kind === 'city') {
    if ('country' in raw) { const c = String(raw.country ?? '').trim().toUpperCase(); if (c && !/^[A-Z]{2}$/.test(c)) return { ok: false, error: 'Pays : 2 lettres (CM) / Country: 2 letters (CM)', field: 'country' }; f.country = c || null }
    for (const k of ['lat', 'lng'] as const) {
      if (!(k in raw)) continue
      const n = raw[k] === '' || raw[k] == null ? null : Number(raw[k])
      if (n !== null && (!Number.isFinite(n) || Math.abs(n) > (k === 'lat' ? 90 : 180))) return { ok: false, error: 'Coordonnée invalide / Invalid coordinate', field: k }
      f[k] = n
    }
    if ('zoom' in raw) f.zoom = raw.zoom === '' || raw.zoom == null ? null : Math.min(18, Math.max(3, Math.round(Number(raw.zoom)) || 13))
    if (create && (f.lat == null || f.lng == null)) return { ok: false, error: 'Centre de la ville requis (lat, lng) / City centre required (lat, lng)', field: 'lat' }
  }
  return { ok: true, fields: f }
}

/** The stored code for a new value: a city keeps its name, an event
 *  category its French label, cuisines and place categories a slug. */
export function codeFor(kind: RefKind, labelFr: string): string {
  if (kind === 'city' || kind === 'event_category') return labelFr.trim()
  return normalizeCuisine(labelFr).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
}

async function countEq(table: string, col: string, value: string, extra?: (q: any) => any): Promise<number> { // eslint-disable-line @typescript-eslint/no-explicit-any
  let q = supabaseAdmin.from(table).select('id', { count: 'exact', head: true }).eq(col, value)
  if (extra) q = extra(q)
  const { count } = await q
  return count ?? 0
}

/** id → how many items use the value. */
export async function usageCounts(rows: RefRow[]): Promise<Record<string, { total: number; detail: Record<string, number> }>> {
  const out: Record<string, { total: number; detail: Record<string, number> }> = {}
  const cuisines = rows.filter(r => r.kind === 'cuisine')
  let restaurantsText: Array<{ cuisine_type: string | null; description: string | null }> = []
  if (cuisines.length) {
    const { data } = await supabaseAdmin.from('restaurants').select('cuisine_type, description').is('deleted_at', null).range(0, 9999)
    restaurantsText = (data ?? []) as typeof restaurantsText
  }
  await Promise.all(rows.map(async r => {
    let detail: Record<string, number> = {}
    if (r.kind === 'city') {
      const [restaurants, events, places, profiles] = await Promise.all([
        countEq('restaurants', 'city', r.code, q => q.is('deleted_at', null)), countEq('events', 'city', r.code),
        countEq('places', 'city', r.code), countEq('customers', 'city', r.code),
      ])
      detail = { restaurants, events, places, profiles }
    } else if (r.kind === 'event_category') detail = { events: await countEq('events', 'category', r.code) }
    else if (r.kind === 'place_category') detail = { places: await countEq('places', 'category', r.code) }
    else detail = { restaurants: restaurantsText.filter(x => matchesCuisineCategory(x, r.code)).length }
    out[r.id] = { total: Object.values(detail).reduce((a, b) => a + b, 0), detail }
  }))
  return out
}
