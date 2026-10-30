// WhatsApp bot menus from the reference data (the backup lists here):
// numbered visible cities / cuisines; a typed unknown name = a proposal;
// cuisine is optional ("0" / "passer"); hidden cities are not offered.

import { setRefValues, REF_BACKUP, type RefValue } from '@/lib/refData'
import { cityMenu, parseCityReply, cuisineMenu, parseCuisineReply } from '@/lib/botRef'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-bot-ref'

async function main(): Promise<void> {
  setRefValues(REF_BACKUP as RefValue[])
  await step('city menu and replies', () => {
    const m = cityMenu('fr')
    assert(m.includes('1️⃣ Yaoundé') && m.includes('2️⃣ Douala'), 'Yaoundé 1, Douala 2')
    assert(!m.includes('Abidjan') && !m.includes('Dakar') && !m.includes('Lomé'), 'hidden cities not offered')
    assertEq(parseCityReply('2'), { city: 'Douala', proposed: null }, 'by number')
    assertEq(parseCityReply('yaounde'), { city: 'Yaoundé', proposed: null }, 'by name, no accent')
    assertEq(parseCityReply('kribi'), { city: 'Kribi', proposed: 'kribi' }, 'a new city → proposal')
    assertEq(parseCityReply('9'), null, 'number out of range → re-ask')
    assertEq(parseCityReply('?'), null, 'nonsense → re-ask')
  })
  await step('cuisine menu and replies (optional)', () => {
    const m = cuisineMenu('en')
    assert(m.includes('(optional)') && m.includes('0 = skip'), 'says optional, 0 = skip')
    assert(m.includes('1️⃣ Grilled') && !m.includes('Other'), 'listed values, no "Autre" line')
    assertEq(parseCuisineReply('0'), { cuisine: null, proposed: null }, '0 → none')
    assertEq(parseCuisineReply('passer'), { cuisine: null, proposed: null }, 'passer → none')
    assertEq(parseCuisineReply('1'), { cuisine: 'Grillades', proposed: null }, 'by number')
    assertEq(parseCuisineReply('Sénégalaise'), { cuisine: 'Sénégalaise', proposed: null }, 'by name')
    assertEq(parseCuisineReply('burgers maison'), { cuisine: 'Fast-food', proposed: 'burgers maison' }, 'new → closest + proposal')
    assertEq(parseCuisineReply('cuisine fusion'), { cuisine: 'Autre', proposed: 'cuisine fusion' }, 'no match → Autre + proposal')
  })
  finish(SUITE)
}

void main()
