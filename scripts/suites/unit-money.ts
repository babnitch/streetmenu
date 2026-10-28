// Money is written one way: "3 000 FCFA" — whole francs, grouped by a
// no-break space, never decimals or another currency (lib/money.ts).

import { formatFCFA, formatAmount } from '@/lib/money'
import { assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-money'
const S = ' '

async function main(): Promise<void> {
  await step('"3 000 FCFA", rounded, grouped by thousands', () => {
    assertEq(formatFCFA(3000), `3${S}000${S}FCFA`, '3000 → 3 000 FCFA')
    assertEq(formatFCFA(500), `500${S}FCFA`, '500 → 500 FCFA')
    assertEq(formatFCFA(1234567), `1${S}234${S}567${S}FCFA`, 'millions grouped')
    assertEq(formatFCFA(2999.6), `3${S}000${S}FCFA`, 'decimals rounded away')
    assertEq(formatFCFA('4500'), `4${S}500${S}FCFA`, 'numeric strings (DB numerics) accepted')
    assertEq(formatFCFA(null), `0${S}FCFA`, 'missing → 0 FCFA')
    assertEq(formatAmount(-1500), `-1${S}500`, 'negative keeps its sign')
    assertEq(formatAmount(NaN), '0', 'NaN → 0')
  })
  finish(SUITE)
}

void main()
