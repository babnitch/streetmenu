// TEST-PLAN.md §1a #1 — parseOrder. Moved from scripts/test-ordering-parser.ts
// per the file map in §2, now running under the shared testkit.
//
// Two cases from the original script were asserting a contract the code no
// longer has, and it has been red on those since. lib/whatsapp/ordering.ts
// deliberately unified "Numéro X invalide" and "Format non compris" into one
// itemNotFoundMessage() that spells out the syntax (see the comment above it),
// so the port asserts the unified message. The code is right; the old
// expectations were stale.
//
// Coverage kept from the original: number/name/compact syntaxes, duplicate
// merging, quantity bounds, and the distinct error classes.

import { parseOrder, itemNotFoundMessage, type ParseOk } from '@/lib/whatsapp/ordering'
import { assert, assertEq, assertIncludes, step, finish } from '../testkit/assert'

const SUITE = 'unit-ordering-parser'

const MENU = [
  { menu_item_id: 'a', name: 'Ndolé',           price: 2500 },
  { menu_item_id: 'b', name: 'Poulet DG',       price: 3500 },
  { menu_item_id: 'c', name: 'Eru',             price: 2000 },
  { menu_item_id: 'd', name: 'Poisson braisé',  price: 3000 },
]

function ok(input: string): ParseOk {
  const r = parseOrder(input, MENU)
  if (!r.ok) throw new Error(`expected "${input}" to parse, got: ${r.error}`)
  return r
}

function err(input: string): string {
  const r = parseOrder(input, MENU)
  if (r.ok) throw new Error(`expected "${input}" to fail, got total ${r.total}`)
  return r.error
}

async function main(): Promise<void> {
  await step('number-based syntax', () => {
    const r = ok('1 x2, 3 x1')
    assertEq(r.total, 7000, '2×Ndolé + 1×Eru = 7000')
    assertEq(r.items.length, 2, 'two line items')
    assertEq(r.items[0].quantity, 2, 'first line quantity')
    assertEq(r.items[0].name, 'Ndolé', 'index 1 resolves to the first menu item')
    assertEq(r.items[1].name, 'Eru', 'index 3 resolves to the third menu item')

    assertEq(ok('2 x3').total, 10500, 'a single token parses on its own')
    assertEq(ok('1x2,3x1').total, 7000, 'compact form (no spaces) parses identically')
    assertEq(ok('1 X 2').items[0].quantity, 2, 'an uppercase X separator works')
    assertEq(ok('1 × 2').items[0].quantity, 2, 'the multiplication sign × works')
  })

  await step('name-based syntax', () => {
    const exact = ok('2 Ndolé, 1 Eru')
    assertEq(exact.total, 7000, 'exact names resolve')
    assertEq(exact.items.length, 2, 'two line items')

    assertEq(ok('2 ndol, 1 eru').total, 7000, 'a partial, lowercase name resolves')
    assertEq(ok('1 POULET DG').items[0].name, 'Poulet DG', 'matching is case-insensitive')
    assertEq(ok('1 poisson').items[0].name, 'Poisson braisé', 'a partial match picks the containing item')
    assertEq(ok('2   Ndolé').items[0].quantity, 2, 'extra spaces between quantity and name are tolerated')
  })

  await step('token separators', () => {
    assertEq(ok('1 x1\n3 x1').total, 4500, 'newlines separate tokens as well as commas')
    assertEq(ok('1 x1, , 3 x1').total, 4500, 'empty tokens between commas are skipped')
    assertEq(ok('  1 x1  ').items.length, 1, 'surrounding whitespace is trimmed')
  })

  await step('duplicate lines merge into one item', () => {
    const r = ok('1 x1, 1 x2')
    assertEq(r.items.length, 1, 'the same item twice yields one line')
    assertEq(r.items[0].quantity, 3, 'quantities are summed')
    assertEq(r.total, 7500, 'the total reflects the merged quantity')

    const byBoth = ok('1 x1, 2 Ndolé')
    assertEq(byBoth.items.length, 1, 'number and name forms merge when they resolve to the same item')
    assertEq(byBoth.items[0].quantity, 3, 'and their quantities sum')
  })

  await step('quantity bounds — 1..99', () => {
    assertEq(ok('1 x1').items[0].quantity, 1, '1 is the minimum accepted')
    assertEq(ok('1 x99').items[0].quantity, 99, '99 is the maximum accepted')
    assertIncludes(err('1 x0'), 'quantité invalide', '0 is rejected')
    assertIncludes(err('1 x100'), 'quantité invalide', '100 is rejected')
    assertIncludes(err('0 Ndolé'), 'quantité invalide', 'a zero quantity in name form is rejected')
    // Merging happens after each token is bounds-checked, so 60+60 is allowed
    // through as a merged 120. Documenting the current behaviour, not
    // endorsing it — the per-line cap is what the code enforces.
    assertEq(ok('1 x60, 1 x60').items[0].quantity, 120,
      'the cap is per line, so merged quantities can exceed it')
  })

  await step('error classes', () => {
    assertIncludes(err(''), 'commande vide', 'empty input')
    assertIncludes(err('   '), 'commande vide', 'whitespace-only input is also empty')
    assertIncludes(err(',,,'), 'commande vide', 'separators with no tokens is also empty')

    // One unified message now covers all three "I could not resolve an item"
    // cases. Asserting they are byte-identical is the point of the change.
    const unknownNumber = err('99 x1')
    const unknownName   = err('1 frites')
    const garbage       = err('hello')
    assertEq(unknownNumber, itemNotFoundMessage('fr'), 'an out-of-range menu number returns the unified message')
    assertEq(unknownName, itemNotFoundMessage('fr'), 'an unknown item name returns the unified message')
    assertEq(garbage, itemNotFoundMessage('fr'), 'unparseable input returns the unified message')
    assertEq(new Set([unknownNumber, unknownName, garbage]).size, 1,
      'all three not-found paths produce exactly the same text')
    assertIncludes(unknownNumber, 'plat introuvable', 'and that text names the problem')
    assertIncludes(unknownNumber, '2x3', 'and shows the expected syntax')

    assertIncludes(err('0 x1'), 'plat introuvable', 'menu index 0 is out of range (the list is 1-based)')
  })

  await step('bilingual errors', () => {
    const fr = parseOrder('', MENU, 'fr')
    const en = parseOrder('', MENU, 'en')
    assertIncludes(fr.ok ? '' : fr.error, 'commande vide', 'FR empty-order message')
    assertIncludes(en.ok ? '' : en.error, 'empty order', 'EN empty-order message')

    const enNotFound = parseOrder('hello', MENU, 'en')
    assertIncludes(enNotFound.ok ? '' : enNotFound.error, 'item not found', 'EN not-found message')

    const enQty = parseOrder('1 x0', MENU, 'en')
    assertIncludes(enQty.ok ? '' : enQty.error, 'invalid quantity', 'EN quantity message')

    assertEq(err('hello'), itemNotFoundMessage('fr'), 'lang defaults to fr')
  })

  await step('an empty menu resolves nothing', () => {
    const r = parseOrder('1 x1', [])
    assert(!r.ok, 'no menu means no item can be found')
  })

  await step('totals', () => {
    assertEq(ok('1 x1').total, 2500, 'one item')
    assertEq(ok('1 x1, 2 x1, 3 x1, 4 x1').total, 11000, 'one of everything sums correctly')
    assertEq(ok('2 x10').total, 35000, 'quantity multiplies the unit price')
    const r = ok('1 x2, 2 x3')
    assertEq(r.total, r.items.reduce((s, i) => s + i.quantity * i.price, 0),
      'the reported total always equals the sum of the line items')
  })

  finish(SUITE)
}

void main()
