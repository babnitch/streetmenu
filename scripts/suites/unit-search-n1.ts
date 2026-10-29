// N1 — one search per section. The Loisirs list and the restaurant list
// filter in place with lib/textSearch.ts: case- and accent-insensitive,
// every word must appear in one of the fields. The bottom bar has no
// Search tab any more and names the section "Loisirs".

import { matchesSearch, foldText } from '@/lib/textSearch'
import { navFor, navLabel } from '@/lib/navConfig'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-search-n1'

async function main(): Promise<void> {
  await step('text search: accents, case, every word', () => {
    assertEq(foldText('Épicé CAFÉ'), 'epice cafe', 'folded')
    assert(matchesSearch('', ['x']), 'empty query matches everything')
    assert(matchesSearch('  ', ['x']), 'blank query matches everything')
    assert(matchesSearch('epice', ['Poulet épicé']), 'no accent finds an accent')
    assert(matchesSearch('NDOLÉ', ['ndole du jour']), 'case and accents both ways')
    assert(matchesSearch('concert bastos', ['Grand concert', null, 'Bastos']), 'words across fields')
    assert(!matchesSearch('concert douala', ['Grand concert', 'Bastos']), 'every word must match')
    assert(!matchesSearch('jazz', [null, undefined, '']), 'no fields → no match')
  })

  await step('bottom bar: 4 tabs, Loisirs / Leisure', () => {
    const tabs = navFor('client', null, false)
    assertEq(tabs.map(t => t.key), ['restaurants', 'events', 'cart', 'account'], 'no Search tab')
    const loisirs = tabs.find(t => t.key === 'events')!
    assertEq(navLabel(loisirs, 'fr'), 'Loisirs', 'FR')
    assertEq(navLabel(loisirs, 'en'), 'Leisure', 'EN')
    assertEq(loisirs.href, '/events', 'opens /events for now')
  })

  finish(SUITE)
}

void main()
