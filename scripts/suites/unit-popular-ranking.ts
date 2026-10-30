// Home rows: the most popular first, filled up to 6 with the rest in a
// fallback order (restaurants: Mise en avant, then newest; events: soonest,
// a running event counting from today) — no duplicates; `popular` only when
// something really is.

import { rankWithFill, eventStartKey, picturesFirst, hasPicture } from '@/lib/popularRanking'
import { placesPicturesFirst, type PublicPlace } from '@/lib/places'
import { assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-popular-ranking'
const ids = (xs: Array<{ id: string }>) => xs.map(x => x.id)

async function main(): Promise<void> {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => ({ id, n: i }))
  const byN = (a: { n: number }, b: { n: number }) => a.n - b.n

  await step('nothing popular → the fallback order, popular = false', () => {
    const r = rankWithFill(items, () => 0, byN, 6)
    assertEq(ids(r.list), ['a', 'b', 'c', 'd', 'e', 'f'], 'first 6 in fallback order')
    assertEq(r.popular, false, 'not popular')
  })

  await step('some popular → those first (most first), then filled, no duplicates', () => {
    const score: Record<string, number> = { g: 5, c: 9 }
    const r = rankWithFill(items, x => score[x.id] ?? 0, byN, 6)
    assertEq(ids(r.list), ['c', 'g', 'a', 'b', 'd', 'e'], 'c, g, then the rest')
    assertEq(r.popular, true, 'popular')
    assertEq(new Set(ids(r.list)).size, r.list.length, 'no duplicates')
  })

  await step('fewer items than the limit → all of them; none → empty', () => {
    assertEq(ids(rankWithFill(items.slice(0, 2), () => 0, byN, 6).list), ['a', 'b'], 'two')
    assertEq(rankWithFill([], () => 0, byN, 6), { list: [], popular: false }, 'empty → hidden row')
    const many = Object.fromEntries(items.map(x => [x.id, 10 - x.n]))
    assertEq(rankWithFill(items, x => many[x.id], byN, 6).list.length, 6, 'never more than 6')
  })

  await step('events: soonest first; a running event counts from today', () => {
    const today = '2026-10-30'
    const evs = [
      { id: 'later', date: '2026-11-05', time: '20:00' },
      { id: 'running', date: '2026-10-20', time: '10:00' },
      { id: 'tonight', date: '2026-10-30', time: '21:00' },
      { id: 'tomorrow', date: '2026-10-31', time: null },
    ]
    const r = rankWithFill(evs, () => 0, (a, b) => eventStartKey(a, today).localeCompare(eventStartKey(b, today)), 6)
    assertEq(ids(r.list), ['running', 'tonight', 'tomorrow', 'later'], 'running (today 10:00), tonight, tomorrow, later')
  })

  await step('home: pictures first, order kept inside each group', () => {
    const xs = [{ id: 'a', t: 2 }, { id: 'b', t: 0 }, { id: 'c', t: 1 }, { id: 'd', t: 0 }, { id: 'e', t: 2 }]
    assertEq(ids(picturesFirst(xs, x => x.t)), ['b', 'd', 'c', 'a', 'e'], 'photo, then cover, then none — stable')
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => ({ id, n: i, photo: ['c', 'f', 'h'].includes(id) }))
    const r = rankWithFill(items, x => (x.id === 'a' ? 5 : 0), (p, q) => p.n - q.n, 4, x => (x.photo ? 0 : 1))
    assertEq(ids(r.list), ['c', 'f', 'h', 'a'], 'free slots filled photo-first; the popular one keeps its slot, after the photos')
    assertEq(r.popular, true, 'still popular')
    assertEq([hasPicture('https://x/y.jpg'), hasPicture(''), hasPicture(null)], [true, false, false], 'hasPicture')
  })

  await step('À visiter: real photo first, then the cover — A–Z in the reader\'s language', () => {
    const pl = (id: string, fr: string, en: string | null, photo: boolean) =>
      ({ id, title_fr: fr, title_en: en, cover_url: photo ? `https://x/${id}.jpg` : null } as unknown as PublicPlace)
    const list = [
      pl('zoo', 'Zoo de Mvog-Betsi', 'Mvog-Betsi Zoo', true),
      pl('bd', 'Boulevard du 20 Mai', null, false),
      pl('mus', 'Musée national', 'National Museum', true),
      pl('arc', 'Arc', null, false),
      pl('bas', 'Basilique', 'Basilica', true),
    ]
    assertEq(ids(placesPicturesFirst(list, 'fr')), ['bas', 'mus', 'zoo', 'arc', 'bd'], 'FR: photos A–Z, then covers A–Z')
    assertEq(ids(placesPicturesFirst(list, 'en')), ['bas', 'zoo', 'mus', 'arc', 'bd'], 'EN: sorted by the English title')
    assertEq(ids(placesPicturesFirst([pl('x', 'X', null, false), pl('e', 'É', null, true)].map(p => ({ ...p, cover_url: p.id === 'x' ? '' : p.cover_url })), 'fr')), ['e', 'x'], 'an empty URL counts as no photo')
  })
  finish(SUITE)
}

void main()
