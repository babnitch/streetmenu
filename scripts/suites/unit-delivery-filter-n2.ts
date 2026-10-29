// N2 — the "🛵 Livraison" pill on the restaurant list keeps only restaurants
// delivering now: the Commandes and Livraison modules AND the restaurant's
// own delivery switch (lib/modules.ts deliversNow, the rule checkout uses).

import { deliversNow } from '@/lib/modules'
import { assert, step, finish } from '../testkit/assert'

const SUITE = 'unit-delivery-filter-n2'

async function main(): Promise<void> {
  await step('only restaurants delivering now pass the pill', () => {
    const list = [
      { id: 'a', modules: ['orders', 'delivery'], delivery_enabled: true },   // delivers
      { id: 'b', modules: ['orders', 'delivery'], delivery_enabled: false },  // switched off
      { id: 'c', modules: ['orders'], delivery_enabled: true },               // no module
      { id: 'd', modules: ['delivery'], delivery_enabled: true },             // Vitrine
      { id: 'e', modules: null, delivery_enabled: true },                     // no modules
    ]
    const kept = list.filter(r => deliversNow(r)).map(r => r.id)
    assert(kept.length === 1 && kept[0] === 'a', `only a kept (got ${kept.join(',')})`)
    assert(!deliversNow(null), 'nothing → no')
  })
  finish(SUITE)
}

void main()
