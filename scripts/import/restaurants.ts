// I3 / D3 — import a restaurants CSV (data/import/, never committed).
//
//   npx tsx scripts/import/restaurants.ts [--file data/import/restaurants_douala.csv]            dry run
//   npx tsx scripts/import/restaurants.ts [--file …] --apply    write
// Default file: restaurants_yaounde.csv. The city comes from each row.
//
// Each row → a restaurant managed by Tchop & Ndjoka (no owner, no team),
// Vitrine (no Commandes), category from cuisine_type, area, links; the
// phone goes to the ADMIN-ONLY restaurant_admin_notes (never used for orders
// or WhatsApp — restaurants.whatsapp stays empty). Map point from Mapbox,
// kept only when found inside the row's city (CITY_BOX), else 0,0 (= no pin). publish_now yes
// → published, no → hidden ("À compléter" in admin). No photo: the generated
// cover shows. Nobody is messaged.
//
// Idempotent: matched on name + city (case-insensitive). A re-run updates
// only what the import owns (area, category, links, point when found, admin
// note) — never the owner, photos, modules or the published state.

import { readFileSync } from 'fs'
import { sb } from '../testkit/env'
import { geocode } from './geocode'
import { validateLinks } from '../../lib/restaurantLinks'
import { parseCsv } from './csv'

const APPLY = process.argv.includes('--apply')
const fileArg = process.argv.indexOf('--file')
const FILE = fileArg > 0 ? process.argv[fileArg + 1] : 'data/import/restaurants_yaounde.csv'
const SOURCE = FILE.split('/').pop()!.replace(/\.csv$/, '')

interface Row {
  name: string; city: string; area: string; cuisine_type: string; geocode_query: string
  facebook: string; instagram: string; tiktok: string; website: string
  phone_to_verify: string; publish_now: string; match_confidence: string; notes: string
}

async function main(): Promise<void> {
  const rows = parseCsv(readFileSync(FILE, 'utf8')) as unknown as Row[]
  const report = { total: rows.length, create: 0, update: 0, publish: 0, hidden: 0, located: 0, noPoint: [] as string[], badLinks: [] as string[], errors: [] as string[] }
  console.log(`${APPLY ? 'IMPORT' : 'DRY RUN'} — ${FILE} — ${rows.length} rows\n`)

  for (const r of rows) {
    const name = r.name.trim()
    const city = r.city.trim() || 'Yaoundé'
    const publish = r.publish_now.trim().toLowerCase() === 'yes'
    const { data: existing } = await sb.from('restaurants').select('id, name').ilike('name', name).eq('city', city).is('deleted_at', null).limit(1)
    const found = existing?.[0] ?? null

    const links = validateLinks({ instagram_url: r.instagram, facebook_url: r.facebook, tiktok_url: r.tiktok, website_url: r.website })
    let linkValues = {}
    if (links.ok) linkValues = links.links
    else {
      report.badLinks.push(`${name}: ${links.field} (${links.error.split(' / ')[0]})`)
      const safe: Record<string, string> = { instagram_url: r.instagram, facebook_url: r.facebook, tiktok_url: r.tiktok, website_url: r.website }
      delete safe[links.field]
      const again = validateLinks(safe)
      linkValues = again.ok ? again.links : {}
    }

    let point: { lat: number; lng: number } | null = null
    try {
      const g = await geocode(r.geocode_query || `${name}, ${city}, Cameroun`, city)
      if (g) point = { lat: g.lat, lng: g.lng }
    } catch (e) { report.errors.push(`${name}: geocode ${(e as Error).message}`) }
    if (point) report.located++
    else report.noPoint.push(name)

    if (found) report.update++; else report.create++
    if (publish) report.publish++; else report.hidden++

    const note = [r.notes.trim(), r.match_confidence ? `confiance: ${r.match_confidence}` : '', `import CSV ${SOURCE}`].filter(Boolean).join(' · ')
    if (!APPLY) continue

    const common = {
      neighborhood: r.area.trim() || null, cuisine_type: r.cuisine_type.trim() || null, ...linkValues,
      ...(point ? { lat: point.lat, lng: point.lng } : {}),
    }
    let id = found?.id as string | undefined
    if (found) {
      const { error } = await sb.from('restaurants').update(common).eq('id', found.id)
      if (error) { report.errors.push(`${name}: ${error.message}`); continue }
    } else {
      const { data, error } = await sb.from('restaurants').insert({
        name, city, ...common, lat: point?.lat ?? 0, lng: point?.lng ?? 0,
        customer_id: null, managed_by_platform: true, modules: [], whatsapp: null, phone: null,
        is_open: false, is_active: publish, status: publish ? 'active' : 'pending',
      }).select('id').single()
      if (error || !data) { report.errors.push(`${name}: ${error?.message}`); continue }
      id = data.id as string
    }
    await sb.from('restaurant_admin_notes').upsert({
      restaurant_id: id, phone_to_verify: r.phone_to_verify.trim() || null, note, updated_at: new Date().toISOString(),
    }, { onConflict: 'restaurant_id' })
  }

  console.log(`rows: ${report.total} · new: ${report.create} · already there (update): ${report.update}`)
  console.log(`published: ${report.publish} · hidden ("À compléter"): ${report.hidden}`)
  console.log(`map point found in the city: ${report.located} · no point (no pin): ${report.noPoint.length}`)
  if (report.noPoint.length) console.log(`  no point: ${report.noPoint.join(' · ')}`)
  if (report.badLinks.length) console.log(`links dropped: ${report.badLinks.join(' · ')}`)
  if (report.errors.length) console.log(`ERRORS: ${report.errors.join(' · ')}`)
  process.exit(report.errors.length ? 1 : 0)
}

void main()
