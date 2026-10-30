// Lieux photos from Wikimedia Commons.
//
//   npx tsx scripts/import/place-photos.ts                 dry run: proposals (published places, then hidden)
//   npx tsx scripts/import/place-photos.ts --apply         upload the proposals and set cover_url + credit
//   npx tsx scripts/import/place-photos.ts --apply --only <placeId,placeId>   just those
//
// For each place with no photo yet: Commons API search (File namespace,
// "<name> <city>"), imageinfo + extmetadata. A file is kept only when:
//   - it is a photo (JPEG / PNG / WebP, at least 800 px wide) — no SVG, no
//     map / logo / flag / plan / portrait / coat of arms in its title;
//   - its title or description names the place (a distinctive word of the
//     place's name, see sameName);
//   - its licence is Public domain, CC0, CC BY or CC BY-SA — never NC / ND,
//     never a missing licence;
//   - it has an author (Artist). Artist and LicenseShortName are used
//     EXACTLY as Commons gives them (HTML tags removed), never guessed.
// --apply downloads the ≈1200 px thumbnail, uploads it to our Storage
// ("photos" bucket, places/commons/…) and sets cover_url, photo_credit
// ("{author}, {licence}") and photo_credit_url (the Commons file page).
// The proposals of the last dry run are kept in a local file (scratch) so
// --apply uploads exactly what was approved.

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { sb } from '../testkit/env'
import { sameName } from './geocode'

const APPLY = process.argv.includes('--apply')
const onlyArg = process.argv.indexOf('--only')
const ONLY = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null
const PROPOSALS = 'data/import/place-photos.proposals.json'   // data/import/ is git-ignored
const API = 'https://commons.wikimedia.org/w/api.php'

const ALLOWED_LICENCE = /^(public domain|pd\b|cc0|cc[- ]by( \d(\.\d)?)?( [a-z]+)?$|cc[- ]by-sa( \d(\.\d)?)?( [a-z]+)?$)/i
const BANNED_LICENCE = /\b(nc|nd)\b|non[- ]?commercial|no[- ]?deriv/i
// A name-only search must still be about Cameroon (no Paris "Marché des Fleurs").
const CAMEROON = /cameroun|cameroon|douala|yaound|limb[eé]|bimbia|mefou|ebogo|mbalmayo|wouri|mvog/i
const NOT_A_PHOTO = /\b(map|carte|plan|logo|flag|drapeau|coat of arms|armoiries|blason|portrait|seal|sceau|diagram|locator|icon)\b/i

interface Proposal {
  placeId: string; place: string; city: string; status: string
  file: string; filePage: string; thumbUrl: string; width: number
  artist: string; licence: string; licenceUrl: string | null
}

let UA = ''
async function commons(params: Record<string, string>): Promise<unknown> {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })}`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Commons HTTP ${res.status}`)
  await new Promise(r => setTimeout(r, 300))   // be gentle
  return res.json()
}

const plain = (html: string | undefined): string => (html ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim()

async function findPhoto(name: string, city: string, query = `${name} ${city}`, mustMention: RegExp | null = null): Promise<Omit<Proposal, 'placeId' | 'place' | 'city' | 'status'> | { reject: string }> {
  const d = await commons({
    action: 'query', generator: 'search', gsrnamespace: '6', gsrlimit: '15', gsrsearch: query,
    prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size', iiurlwidth: '1200',
  }) as { query?: { pages?: Array<{ title: string; index?: number; imageinfo?: Array<Record<string, unknown>> }> } }
  const pages = (d.query?.pages ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  if (!pages.length) return { reject: 'aucun fichier trouvé' }
  const reasons: string[] = []
  for (const p of pages) {
    const ii = p.imageinfo?.[0] as { mime?: string; width?: number; thumburl?: string; descriptionurl?: string; extmetadata?: Record<string, { value?: string }> } | undefined
    if (!ii) continue
    const title = p.title.replace(/^File:/, '')
    const meta = ii.extmetadata ?? {}
    const licence = plain(meta.LicenseShortName?.value)
    const artist = plain(meta.Artist?.value)
    const desc = plain(meta.ImageDescription?.value) + ' ' + plain(meta.ObjectName?.value)
    if (!/^image\/(jpeg|png|webp)$/.test(ii.mime ?? '')) { reasons.push(`${title}: pas une photo`); continue }
    if ((ii.width ?? 0) < 800) { reasons.push(`${title}: trop petite`); continue }
    if (NOT_A_PHOTO.test(title) || NOT_A_PHOTO.test(plain(meta.Categories?.value).slice(0, 300))) { reasons.push(`${title}: carte/logo/portrait`); continue }
    if (!sameName(name, `${title} ${desc}`)) { reasons.push(`${title}: ne nomme pas le lieu`); continue }
    if (mustMention && !mustMention.test(`${title} ${desc} ${plain(meta.Categories?.value)}`)) { reasons.push(`${title}: pas au Cameroun`); continue }
    if (!licence || BANNED_LICENCE.test(licence) || !ALLOWED_LICENCE.test(licence)) { reasons.push(`${title}: licence « ${licence || 'absente'} »`); continue }
    if (!artist) { reasons.push(`${title}: auteur absent`); continue }
    if (!ii.thumburl || !ii.descriptionurl) continue
    return {
      file: title, filePage: ii.descriptionurl, thumbUrl: ii.thumburl, width: ii.width ?? 0,
      artist, licence, licenceUrl: plain(meta.LicenseUrl?.value) || null,
    }
  }
  return { reject: reasons.slice(0, 2).join(' · ') || 'rien de convenable' }
}

async function main(): Promise<void> {
  // Our contact e-mail (Plateforme → Infos légales), else the owner's.
  const { data: legal } = await sb.from('platform_settings').select('value').eq('key', 'legal_contact').maybeSingle()
  const contact = (legal?.value as Record<string, string> | null)?.contact_email || process.env.IMPORT_CONTACT_EMAIL || 'babette.nitcheu@gmail.com'
  UA = `TchopNdjokaPlacePhotos/1.0 (https://streetmenu.vercel.app; ${contact}) node-fetch`

  if (APPLY) return apply()

  const { data } = await sb.from('places').select('id, title_fr, city, status, cover_url').is('cover_url', null)
  const places = ((data ?? []) as Array<{ id: string; title_fr: string; city: string; status: string }>)
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || a.city.localeCompare(b.city) || a.title_fr.localeCompare(b.title_fr))
  console.log(`DRY RUN — ${places.length} places without a photo\n`)
  const found: Proposal[] = [], none: string[] = []
  for (const p of places) {
    try {
      let r = await findPhoto(p.title_fr, p.city)
      // Day trips (Limbé, Bimbia…) are not in the city: try the name alone,
      // without its bracketed part.
      if ('reject' in r) {
        const bare = p.title_fr.replace(/\s*\([^)]*\)/g, '').trim()
        const again = await findPhoto(p.title_fr, p.city, bare, CAMEROON)
        if (!('reject' in again)) r = again
      }
      if ('reject' in r) { none.push(`${p.title_fr} (${p.city}${p.status === 'active' ? '' : ', masqué'}) — ${r.reject}`); continue }
      found.push({ placeId: p.id, place: p.title_fr, city: p.city, status: p.status, ...r })
    } catch (e) { none.push(`${p.title_fr} — erreur ${(e as Error).message}`) }
  }
  for (const f of found) {
    console.log(`📷 ${f.place} (${f.city}${f.status === 'active' ? '' : ', masqué'})\n    ${f.filePage}\n    ${f.licence} · ${f.artist}`)
  }
  console.log(`\nproposals: ${found.length} · nothing suitable: ${none.length}`)
  for (const n of none) console.log(`  – ${n}`)
  writeFileSync(PROPOSALS, JSON.stringify(found, null, 2))
  console.log(`\n(saved for --apply: ${PROPOSALS})`)
}

async function apply(): Promise<void> {
  if (!existsSync(PROPOSALS)) throw new Error('run the dry run first')
  const all = JSON.parse(readFileSync(PROPOSALS, 'utf8')) as Proposal[]
  const list = ONLY ? all.filter(p => ONLY.has(p.placeId)) : all
  console.log(`APPLY — ${list.length} photos`)
  let ok = 0
  for (const p of list) {
    try {
      const res = await fetch(p.thumbUrl, { headers: { 'User-Agent': UA } })
      if (!res.ok) throw new Error(`download HTTP ${res.status}`)
      const type = res.headers.get('content-type') ?? 'image/jpeg'
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'
      const path = `places/commons/${p.placeId}.${ext}`
      const up = await sb.storage.from('photos').upload(path, Buffer.from(await res.arrayBuffer()), { contentType: type, upsert: true })
      if (up.error) throw new Error(`upload: ${up.error.message}`)
      const url = sb.storage.from('photos').getPublicUrl(path).data.publicUrl
      const { error } = await sb.from('places').update({
        cover_url: url, photo_credit: `${p.artist}, ${p.licence}`, photo_credit_url: p.filePage, updated_at: new Date().toISOString(),
      }).eq('id', p.placeId).is('cover_url', null)
      if (error) throw new Error(error.message)
      ok++
      console.log(`  ✓ ${p.place}`)
    } catch (e) { console.log(`  ✗ ${p.place}: ${(e as Error).message}`) }
  }
  console.log(`done: ${ok}/${list.length}`)
}

main().catch(e => { console.error('ERROR', (e as Error).message); process.exit(1) })
