// I6 — import 8 chosen events from data/import/events_yaounde.csv, as
// "Infos seulement" (no booking, payment or QR on the platform; a
// "Billets / Infos" link), managed by Tchop & Ndjoka, published, with the
// generated poster. Written straight to the table: nobody is messaged — not
// the organiser, not the subscribers (the fan-out only runs on approval).
//
//   npx tsx scripts/import/events.ts            dry run (report only)
//   npx tsx scripts/import/events.ts --apply    write
//
// Idempotent: matched on title + city + start date.

import { readFileSync } from 'fs'
import { sb } from '../testkit/env'
import { parseCsv } from './csv'
import { validateEventRange, normalizeEndDate } from '../../lib/eventDate'
import { EVENT_CATEGORIES } from '../../lib/categoryLabels'

const APPLY = process.argv.includes('--apply')
const FILE = 'data/import/events_yaounde.csv'
const CITY = 'Yaoundé'

// The 8 titles chosen (the CSV's titles are longer).
const WANTED = [
  'Univers. Homme. Intelligence', 'Yaoundé Jazz Festival 2026', 'The Divine Tour by Phido', 'Afro Kavod',
  'DevFest Yaoundé 2026', 'Écrans Noirs – 30e édition', 'Semaine internationale des fous du livre', 'Christmas Night',
]
const CATEGORY: Record<string, string> = {
  Exposition: 'Culture', 'Cinéma': 'Culture', 'Conférence': 'Business', 'Soirée': 'BT/Club', Concert: 'Concert', Festival: 'Festival',
}

interface Row {
  title: string; category: string; start_date: string; end_date: string; start_time: string; venue: string; area: string
  price_fcfa: string; organiser: string; ticket_or_info_link: string; source_url: string; confidence: string; notes: string; description_fr: string
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// "free" → 0, "à partir de 3000" → 3000 + from, "2500" → 2500, "" → unknown.
function price(raw: string): { price: number | null; from: boolean } {
  const t = raw.trim().toLowerCase()
  if (!t) return { price: null, from: false }
  if (/^(free|gratuit)/.test(t)) return { price: 0, from: false }
  const n = Number((t.match(/\d[\d\s.]*/)?.[0] ?? '').replace(/[\s.]/g, ''))
  return Number.isFinite(n) && n > 0 ? { price: n, from: /partir|from|dès/.test(t) } : { price: null, from: false }
}

async function main(): Promise<void> {
  const rows = parseCsv(readFileSync(FILE, 'utf8')) as unknown as Row[]
  console.log(`${APPLY ? 'IMPORT' : 'DRY RUN'} — ${FILE} — ${rows.length} rows, ${WANTED.length} wanted\n`)
  const errors: string[] = []
  let create = 0, update = 0

  for (const want of WANTED) {
    const hits = rows.filter(r => norm(r.title).includes(norm(want)))
    if (hits.length !== 1) { errors.push(`"${want}": ${hits.length} rows match`); continue }
    const r = hits[0]
    const category = CATEGORY[r.category.trim()]
    if (!category || !(EVENT_CATEGORIES as readonly string[]).includes(category)) { errors.push(`"${want}": category ${r.category}`); continue }
    const range = { date: r.start_date.trim(), time: r.start_time.trim() || null, end_date: r.end_date.trim() || null, end_time: null }
    const rangeErr = validateEventRange(range)
    if (rangeErr) { errors.push(`"${want}": dates ${rangeErr}`); continue }
    const link = r.ticket_or_info_link.trim()
    const p = price(r.price_fcfa)
    const endDate = normalizeEndDate(range.date, range.end_date)

    const { data: found } = await sb.from('events').select('id').eq('city', CITY).eq('title', r.title.trim()).eq('date', range.date).limit(1)
    const id = found?.[0]?.id as string | undefined
    if (id) update++; else create++
    const priceTxt = p.price == null ? 'prix ?' : p.price === 0 ? 'gratuit' : `${p.from ? 'dès ' : ''}${p.price} FCFA`
    console.log(`${id ? '↻' : '+'} ${r.title.trim()}\n    ${category} · ${range.date}${endDate ? ` → ${endDate}` : ''}${range.time ? ` ${range.time}` : ''} · ${r.venue.trim() || 'lieu ?'} · ${priceTxt} · ${r.organiser.trim() || 'organisateur ?'} · ${/^https?:\/\//.test(link) ? 'lien ✓' : 'pas de lien'}`)
    if (!APPLY) continue

    const fields = {
      title: r.title.trim().slice(0, 140), category, city: CITY,
      date: range.date, time: range.time, end_date: endDate, end_time: null,
      venue: r.venue.trim().slice(0, 120) || null, neighborhood: r.area.trim().slice(0, 80) || null,
      description: r.description_fr.trim().slice(0, 2000) || null,
      price: p.price, ticket_price: p.price, price_is_from: p.from,
      booking_mode: 'info', info_link: /^https?:\/\/\S+$/.test(link) ? link : null,
      organizer_name: r.organiser.trim().slice(0, 80) || null,
    }
    if (id) {
      const { error } = await sb.from('events').update(fields).eq('id', id)
      if (error) errors.push(`"${want}": ${error.message}`)
    } else {
      const { error } = await sb.from('events').insert({
        ...fields, max_tickets: 0, payment_enabled: false, payment_mode: 'reservation_only', whatsapp_payment_enabled: false,
        requires_confirmation: false, cover_photo: null, whatsapp: null, notify_phone: null,
        organizer_id: null, managed_by_platform: true, is_active: true, auto_approved: false, event_status: 'upcoming',
      })
      if (error) errors.push(`"${want}": ${error.message}`)
    }
  }
  console.log(`\nnew: ${create} · already there (update): ${update}`)
  if (errors.length) console.log(`ERRORS: ${errors.join(' · ')}`)
  process.exit(errors.length ? 1 : 0)
}

void main()
