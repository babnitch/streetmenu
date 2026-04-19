import { parseOrder } from '../lib/whatsapp/ordering'

const menu = [
  { menu_item_id: 'a', name: 'Ndolé',       price: 2500 },
  { menu_item_id: 'b', name: 'Poulet DG',   price: 3500 },
  { menu_item_id: 'c', name: 'Eru',         price: 2000 },
  { menu_item_id: 'd', name: 'Poisson braisé', price: 3000 },
]

const cases: Array<[string, string, unknown]> = [
  ['number-based',     '1 x2, 3 x1', { total: 7000, count: 2 }],
  ['compact',          '1x2,3x1',    { total: 7000, count: 2 }],
  ['name-based exact', '2 Ndolé, 1 Eru', { total: 7000, count: 2 }],
  ['name-based partial', '2 ndol, 1 eru', { total: 7000, count: 2 }],
  ['single token',     '2 x3',        { total: 10500, count: 1 }],
  ['dup merge',        '1 x1, 1 x2', { total: 7500, count: 1, qty: 3 }],
  ['bad quantity',     '1 x0',        { error: 'quantité' }],
  ['huge quantity',    '1 x100',      { error: 'quantité' }],
  ['unknown number',   '99 x1',       { error: 'invalide' }],
  ['unknown name',     '1 frites',    { error: 'introuvable' }],
  ['empty',            '',            { error: 'vide' }],
  ['garbage',          'hello',       { error: 'non compris' }],
]

let pass = 0, fail = 0
for (const [label, input, want] of cases) {
  const r = parseOrder(input, menu)
  if ((want as { error?: string }).error) {
    if (!r.ok && r.error.toLowerCase().includes((want as { error: string }).error.toLowerCase())) {
      console.log(`✓ ${label}: "${input}" → error matches`)
      pass++
    } else {
      console.log(`✗ ${label}: "${input}" → ${JSON.stringify(r)} (wanted error "${(want as { error: string }).error}")`)
      fail++
    }
    continue
  }
  const w = want as { total: number; count: number; qty?: number }
  if (r.ok && r.total === w.total && r.items.length === w.count && (w.qty === undefined || r.items[0].quantity === w.qty)) {
    console.log(`✓ ${label}: "${input}" → total ${r.total}, ${r.items.length} items`)
    pass++
  } else {
    console.log(`✗ ${label}: "${input}" → ${JSON.stringify(r)} (wanted ${JSON.stringify(w)})`)
    fail++
  }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
