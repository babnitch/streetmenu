// I5 — import data/import/places_yaounde_douala.csv into places.
//
//   npx tsx scripts/import/places.ts            dry run (report only)
//   npx tsx scripts/import/places.ts --apply    write
//
// name → title_fr (the place's name, the same in both languages); the CSV's
// title_fr / title_en are the editorial headline (headline_fr / _en).
// publish = yes → published; check / no → hidden, the reason in admin_note.
// Sources stay admin-only. Category mapped with CSV_CATEGORY. Map point:
// Mapbox, else OpenStreetMap, kept only inside the row's city; else none
// (Itinéraire then searches the name). No photo: the generated cover shows.
//
// Idempotent: matched on city + name (case-insensitive). A re-run updates
// the imported fields but never the status an admin has since changed, nor
// a photo or links an admin added.

import { readFileSync } from 'fs'
import { sb } from '../testkit/env'
import { geocode, geocodeOsm, CITY_BOX } from './geocode'
import { parseCsv } from './csv'
import { CSV_CATEGORY, validatePlace } from '../../lib/places'

const APPLY = process.argv.includes('--apply')
const FILE = 'data/import/places_yaounde_douala.csv'

interface Row {
  city: string; name: string; category: string; area: string; publish: string; publish_reason: string
  title_en: string; description_en: string; tip_en: string; title_fr: string; description_fr: string; tip_fr: string
  price: string; hours: string; official_link: string; sources: string
}

async function main(): Promise<void> {
  const rows = parseCsv(readFileSync(FILE, 'utf8')) as unknown as Row[]
  const r0 = { total: rows.length, create: 0, update: 0, publish: 0, hidden: 0 }
  const located: string[] = [], noPoint: string[] = [], errors: string[] = [], skipped: string[] = []
  const byCity: Record<string, { publish: number; hidden: number }> = {}
  console.log(`${APPLY ? 'IMPORT' : 'DRY RUN'} — ${FILE} — ${rows.length} rows\n`)

  const { data: existingRows } = await sb.from('places').select('id, city, title_fr')
  const existing = new Map((existingRows ?? []).map(p => [`${p.city}|${String(p.title_fr).toLowerCase()}`, p.id as string]))

  for (const r of rows) {
    const name = r.name.trim(), city = r.city.trim()
    const category = CSV_CATEGORY[r.category.trim()]
    if (!name || !CITY_BOX[city] || !category) { skipped.push(`${name || '?'} (${city}, ${r.category})`); continue }
    const publish = r.publish.trim().toLowerCase() === 'yes'
    const reason = r.publish_reason.trim()
    const note = [publish ? '' : `publish: ${r.publish.trim()}`, reason, 'import CSV places_yaounde_douala'].filter(Boolean).join(' · ')

    const v = validatePlace({
      city, area: r.area, category, title_fr: name,
      headline_fr: r.title_fr, headline_en: r.title_en,
      description_fr: r.description_fr, description_en: r.description_en, tip_fr: r.tip_fr, tip_en: r.tip_en,
      hours: r.hours, price: r.price, official_link: /^https?:\/\//.test(r.official_link.trim()) ? r.official_link : '',
      admin_note: note, sources: r.sources,
    }, true)
    if (!v.ok) { errors.push(`${name}: ${v.field} ${v.error}`); continue }

    let point: { lat: number; lng: number } | null = null
    const q = [name, r.area.trim(), city, 'Cameroun'].filter(Boolean).join(', ')
    try {
      const g = await geocode(q, city) ?? await geocodeOsm(`${name}, ${city}`, city)
      if (g) { point = { lat: g.lat, lng: g.lng }; located.push(`${name} → ${g.kind} (${g.label.split(',').slice(0, 2).join(',')})`) }
    } catch (e) { errors.push(`${name}: geocode ${(e as Error).message}`) }
    if (!point) noPoint.push(`${name} (${city})`)

    const id = existing.get(`${city}|${name.toLowerCase()}`)
    if (id) r0.update++; else r0.create++
    if (publish) r0.publish++; else r0.hidden++
    const c = (byCity[city] ??= { publish: 0, hidden: 0 }); if (publish) c.publish++; else c.hidden++
    if (!APPLY) continue

    const fields = { ...v.place, ...(point ? { lat: point.lat, lng: point.lng } : {}), managed_by_platform: true, updated_at: new Date().toISOString() }
    if (id) {
      const { error } = await sb.from('places').update(fields).eq('id', id)
      if (error) errors.push(`${name}: ${error.message}`)
    } else {
      const { data, error } = await sb.from('places').insert({ ...fields, status: publish ? 'active' : 'hidden' }).select('id').single()
      if (error || !data) errors.push(`${name}: ${error?.message}`)
      else existing.set(`${city}|${name.toLowerCase()}`, data.id as string)
    }
  }

  console.log(`rows: ${r0.total} · new: ${r0.create} · already there (update): ${r0.update}`)
  console.log(`published: ${r0.publish} · hidden (reason in admin note): ${r0.hidden}`)
  for (const [c, n] of Object.entries(byCity)) console.log(`  ${c}: ${n.publish} published, ${n.hidden} hidden`)
  console.log(`map point found: ${located.length} · no point: ${noPoint.length}`)
  for (const l of located) console.log(`  📍 ${l}`)
  if (skipped.length) console.log(`skipped (unknown city/category): ${skipped.join(' · ')}`)
  if (errors.length) console.log(`ERRORS: ${errors.join(' · ')}`)
  process.exit(errors.length ? 1 : 0)
}

void main()
