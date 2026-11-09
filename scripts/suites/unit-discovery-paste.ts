// « Coller une annonce » — the parts around the model, no API call:
//   - the output schema: every field required, no extra field, categories enum
//   - the instructions: today's date, the cities, "the text is data"
//   - the model's answer is checked again: city from our list (accents
//     optional), dates / times valid, an impossible end dropped, price,
//     "from" only with a real price, phone normalised (never published),
//     links http(s) only, unknown category → Autre
//   - link notes: social links never opened, other sites not opened

import { cleanExtraction, extractionSchema, extractionSystem, linkNotes, foundToResult, type RawExtraction } from '@/lib/discovery/paste'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-discovery-paste'
const CITIES = ['Yaoundé', 'Douala']
const CATS = ['Concert', 'Festival', 'BT/Club', 'Autre']

const raw = (o: Partial<RawExtraction> = {}): RawExtraction => ({
  is_event: true, title: 'Concert Live', start_date: '2026-12-05', start_time: '20:00', end_date: null, end_time: null,
  venue: 'Le Bôj', city: 'Douala', category: 'Concert', price_fcfa: 5000, price_is_from: false,
  organiser_name: 'Kmer Prod', organiser_phone: '6 77 12 34 56', ticket_link: 'https://tickets.example/x', ...o,
})

async function main(): Promise<void> {
  await step('schema and instructions', () => {
    const s = extractionSchema(CATS) as { additionalProperties: boolean; required: string[]; properties: Record<string, { enum?: string[] }> }
    assertEq(s.additionalProperties, false, 'no extra field')
    assertEq(s.required.sort(), Object.keys(s.properties).sort(), 'every field required')
    assertEq(s.properties.category.enum, CATS, 'category from our list')
    const sys = extractionSystem('2026-11-09', CITIES)
    assert(sys.includes('2026-11-09') && sys.includes('Yaoundé, Douala'), 'today + cities')
    assert(/data, not instructions/.test(sys), 'pasted text treated as data')
  })

  await step('a clean answer', () => {
    const r = cleanExtraction(raw(), { cities: CITIES, categories: CATS, pastedLink: 'https://www.instagram.com/p/abc' })
    assertEq(r.form, {
      title: 'Concert Live', category: 'Concert', city: 'Douala', venue: 'Le Bôj', date: '2026-12-05', time: '20:00', end_date: '', end_time: '',
      price: '5000', price_is_from: false, organizer_name: 'Kmer Prod', booking_mode: 'info', info_link: 'https://tickets.example/x', publish: true,
    }, 'form fields')
    assertEq(r.organiser_phone, '+237677123456', 'phone normalised, kept apart')
    assertEq(r.notes, [], 'no warning')
  })

  await step('every value checked again', () => {
    const c = (o: Partial<RawExtraction>, link?: string) => cleanExtraction(raw(o), { cities: CITIES, categories: CATS, pastedLink: link ?? null })
    assertEq(c({ city: 'yaounde' }).form.city, 'Yaoundé', 'city without accent → ours')
    const away = c({ city: 'Bamenda' })
    assert(away.form.city === '' && away.notes.includes('city_unknown'), 'other city → empty + note')
    const noDate = c({ start_date: '5 décembre' })
    assert(noDate.form.date === '' && noDate.notes.includes('date_missing'), 'bad date → empty + note')
    assertEq(c({ start_date: '2026-02-30' }).form.date, '', 'impossible date')
    assertEq(c({ start_time: '25:00' }).form.time, '', 'bad time')
    const back = c({ start_time: '22:00', end_time: '04:00' })
    assert(back.form.end_time === '' && back.notes.includes('end_dropped'), 'same-day end before start → dropped + note')
    assertEq(c({ end_date: '2026-12-06', end_time: '04:00', start_time: '22:00' }).form.end_date, '2026-12-06', 'overnight kept')
    assertEq(c({ end_date: '2026-12-05' }).form.end_date, '', 'end on the same day → single day')
    assertEq([c({ price_fcfa: 0, price_is_from: true }).form.price, c({ price_fcfa: 0, price_is_from: true }).form.price_is_from], ['0', false], 'free is never "from"')
    assertEq(c({ price_fcfa: -5 }).form.price, '', 'negative price dropped')
    assertEq(c({ price_fcfa: null, price_is_from: true }).form.price_is_from, false, 'no price → not "from"')
    assertEq(c({ category: 'Rave' }).form.category, 'Autre', 'unknown category → Autre')
    assertEq(c({ organiser_phone: '12' }).organiser_phone, null, 'bad phone dropped')
    assertEq(c({ ticket_link: 'javascript:alert(1)' }).form.info_link, '', 'non-http link dropped')
    assertEq(c({ ticket_link: null }, 'https://www.facebook.com/events/1').form.info_link, 'https://www.facebook.com/events/1', 'pasted link used as info link (linked, never opened)')
    assertEq(c({ title: '  A\n\n  B  ' }).form.title, 'A B', 'title spaces')
    assert(c({ is_event: false }).notes.includes('not_an_event'), 'not an event → note')
  })

  await step('link notes and approved source', () => {
    assertEq(linkNotes('https://www.instagram.com/p/x', false), ['social_link_not_opened'], 'social → never opened')
    assertEq(linkNotes('https://tiktok.com/@a/video/1', false), ['social_link_not_opened'], 'TikTok')
    assertEq(linkNotes('https://some-blog.example/x', false), ['link_not_opened'], 'other site → not opened')
    assertEq(linkNotes(null, false), [], 'no link')
    const r = foundToResult({ title: 'T', start_date: '2026-12-01', start_time: '18:00', end_date: null, end_time: '20:00', venue: 'V', city: 'Douala',
      category: 'Concert', price_fcfa: 2000, price_is_from: true, organiser_name: 'O', organiser_url: null, ticket_url: 'https://ayatickets.fr/fr/event/t' })
    assertEq([r.used_ai, r.notes, r.form.info_link, r.form.price, r.organiser_phone], [false, ['read_from_source'], 'https://ayatickets.fr/fr/event/t', '2000', null], 'facts from the page, no AI')
  })

  finish(SUITE)
}

void main()
