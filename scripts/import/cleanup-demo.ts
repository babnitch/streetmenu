// I0 — remove the 5 demo Yaoundé restaurants (with their dishes, hours,
// team rows, test orders) and their 5 demo owner accounts — an owner only
// when it has no other activity. MeResto and everything else stays.
//
//   npx tsx scripts/import/cleanup-demo.ts            dry run (report only)
//   npx tsx scripts/import/cleanup-demo.ts --apply    delete
//
// Nobody is messaged.

import { sb } from '../testkit/env'

const APPLY = process.argv.includes('--apply')
// Batches of demo restaurants: --batch 1 (default, I0) or --batch 2 (the
// remaining demo seeds, 2026-10-30).
const BATCHES: Record<string, Array<[string, string]>> = {
  '1': ['Le Braiseur du Centre', 'Maquis Mvog-Ada', 'Chez Tantine Adjoua', 'Grillade Etoudi Palace', 'Snack Biyem-Assi Express'].map(n => [n, 'Yaoundé']),
  '2': [
    ['Spice Garden', 'Zurich'], ['Pasta & Co.', 'Zurich'], ['Züri Street Grill', 'Zurich'],
    ['Tchop', 'Yaoundé'], ['Chez Mama Biya', 'Yaoundé'], ['Restaurant Fouda & Fils', 'Yaoundé'],
    ['La Terrasse de Briqueterie', 'Yaoundé'], ['Le Bord du Lac — Melen', 'Yaoundé'], ['Al-Wadi Libanais', 'Yaoundé'],
  ],
}
const batchArg = process.argv.indexOf('--batch')
const BATCH = BATCHES[batchArg > 0 ? process.argv[batchArg + 1] : '1']
if (!BATCH) throw new Error('unknown --batch')
const NAMES = BATCH.map(([n]) => n)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function count(table: string, col: string, ids: string[], extra?: (q: any) => any): Promise<number> {
  if (!ids.length) return 0
  let q = sb.from(table).select('*', { count: 'exact', head: true }).in(col, ids)
  if (extra) q = extra(q)
  const { count: n, error } = await q
  if (error) throw new Error(`${table}.${col}: ${error.message}`)
  return n ?? 0
}

async function main(): Promise<void> {
  console.log(`${APPLY ? 'DELETE' : 'DRY RUN'} — demo restaurants\n`)
  const { data: rests, error } = await sb.from('restaurants').select('id, name, city, customer_id, managed_by_platform').in('name', NAMES).is('deleted_at', null)
  if (error) throw error
  const found = (rests ?? []).filter(r => BATCH.some(([n, c]) => n === r.name && c === r.city))
  for (const n of NAMES) if (!found.some(r => r.name === n)) console.log(`  (not found: ${n})`)
  if (found.length !== found.map(r => r.name).filter((v, i, a) => a.indexOf(v) === i).length) throw new Error('duplicate names — stop')
  const rIds = found.map(r => r.id as string)

  // Owners: the restaurant's customer + its team owners.
  const { data: team } = await sb.from('restaurant_team').select('restaurant_id, customer_id, role').in('restaurant_id', rIds)
  const ownerIds = Array.from(new Set([...found.map(r => r.customer_id as string | null), ...(team ?? []).map(t => t.customer_id as string)].filter(Boolean) as string[]))
  const { data: owners } = await sb.from('customers').select('id, name, phone').in('id', ownerIds)

  const { data: orders } = await sb.from('orders').select('id, customer_id').in('restaurant_id', rIds)
  const orderIds = (orders ?? []).map(o => o.id as string)
  for (const r of found) {
    const id = [r.id as string]
    console.log(`• ${r.name}: dishes ${await count('menu_items', 'restaurant_id', id)}, orders ${await count('orders', 'restaurant_id', id)}, hours ${await count('restaurant_hours', 'restaurant_id', id)}, team ${await count('restaurant_team', 'restaurant_id', id)}, ratings ${await count('restaurant_ratings', 'restaurant_id', id)}, vouchers ${await count('vouchers', 'restaurant_id', id)}, offers ${await count('menu_offers', 'restaurant_id', id)}, favourites ${await count('customer_favorites', 'restaurant_id', id)}`)
  }
  console.log(`  order items: ${await count('order_items', 'order_id', orderIds)}`)

  // An owner is deleted only with no activity outside these restaurants.
  const keep: string[] = [], drop: string[] = []
  for (const c of owners ?? []) {
    const id = [c.id as string]
    const other = {
      teams: await count('restaurant_team', 'customer_id', id, q => q.not('restaurant_id', 'in', `(${rIds.join(',')})`)),
      restaurants: await count('restaurants', 'customer_id', id, q => q.not('id', 'in', `(${rIds.join(',')})`)),
      orders: await count('orders', 'customer_id', id, q => q.not('restaurant_id', 'in', `(${rIds.join(',')})`)),
      events: await count('events', 'organizer_id', id) + await count('events', 'submitted_by', id),
      bookings: await count('event_reservations', 'customer_id', id),
      ratings: await count('restaurant_ratings', 'customer_id', id),
      favourites: await count('customer_favorites', 'customer_id', id),
      subscriptions: await count('event_subscriptions', 'customer_id', id),
      usedVouchers: await count('customer_vouchers', 'customer_id', id, q => q.not('used_at', 'is', null)),
    }
    const busy = Object.entries(other).filter(([, n]) => n > 0)
    const label = `${c.name} (${String(c.phone).slice(0, 7)}…)`
    if (busy.length) keep.push(`${label}: ${busy.map(([k, n]) => `${k} ${n}`).join(', ')}`)
    else drop.push(c.id as string)
    console.log(`  owner ${label}: ${busy.length ? 'KEEP — ' + busy.map(([k, n]) => `${k} ${n}`).join(', ') : 'no other activity → delete'}`)
  }
  const { data: me } = await sb.from('restaurants').select('id').ilike('name', '%MeResto%')
  console.log(`\nrestaurants to delete: ${found.length} · owners to delete: ${drop.length} · owners kept: ${keep.length} · MeResto rows untouched: ${(me ?? []).length}`)
  if (!APPLY) return

  const del = async (table: string, col: string, ids: string[]) => {
    if (!ids.length) return
    const { error: e } = await sb.from(table).delete().in(col, ids)
    if (e) throw new Error(`delete ${table}: ${e.message}`)
  }
  await del('order_items', 'order_id', orderIds)
  await del('scan_tokens', 'order_id', orderIds).catch(() => null)
  await del('orders', 'id', orderIds)
  for (const t of ['menu_offers', 'menu_items', 'restaurant_hours', 'restaurant_ratings', 'customer_favorites', 'vouchers', 'restaurant_menu_files', 'restaurant_order_phones', 'restaurant_riders', 'team_invitations', 'restaurant_team']) {
    await del(t, 'restaurant_id', rIds)
  }
  await del('restaurants', 'id', rIds)
  // Owner leftovers that only belong to them (sessions, codes).
  const phones = (owners ?? []).filter(c => drop.includes(c.id as string)).map(c => c.phone as string)
  await del('signup_sessions', 'phone', phones)
  // Vouchers handed to a demo owner and never used go with the account.
  if (drop.length) {
    const { error: vErr } = await sb.from('customer_vouchers').delete().in('customer_id', drop).is('used_at', null)
    if (vErr) throw new Error(`delete customer_vouchers: ${vErr.message}`)
  }
  await del('customers', 'id', drop)
  console.log('done.')
}

main().catch(e => { console.error('ERROR', e.message); process.exit(1) })
