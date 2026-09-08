// TEST-PLAN.md §1c #30 — menu CRUD and its authorization.
//
// New coverage: no existing script tested these routes. They replaced a
// browser-side anon-key INSERT/UPDATE/DELETE on menu_items, where the table's
// write policies were WITH CHECK (true) — so the anon key let anyone write
// any restaurant's menu. The authz block below is the point of this suite;
// the happy paths are there so a regression in the gate can be told apart
// from a regression in the route.
//
// Routes under test:
//   POST   /api/restaurants/[id]/menu
//   PATCH  /api/restaurants/[id]/menu/[itemId]
//   DELETE /api/restaurants/[id]/menu/[itemId]
//
// The gate is lib/vendorAccess.ts denyUnlessOwnerOrManager:
//   no session → 401 · non-customer non-admin → 401 · admin → allowed
//   restaurants.customer_id === session → allowed (implicit owner)
//   active owner|manager team row → allowed · anything else incl. staff → 403

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem, addTeamMember } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-menu-crud'

interface ItemBody {
  ok?:   boolean
  item?: { id: string; restaurant_id: string; name: string; price: number; category: string; is_available: boolean }
  error?: string
}

async function main(): Promise<void> {
  try {
    // ── Fixtures ───────────────────────────────────────────────────────────
    const owner    = await makeCustomer({ suiteNo: 30, name: 'Menu Owner' })
    const manager  = await makeCustomer({ suiteNo: 30, name: 'Menu Manager' })
    const staff    = await makeCustomer({ suiteNo: 30, name: 'Menu Staff' })
    const outsider = await makeCustomer({ suiteNo: 30, name: 'Menu Outsider' })

    const restA = await makeRestaurant({ ownerId: owner.id, label: 'menu_a', whatsapp: owner.phone })
    await addTeamMember(restA.id, manager.id, 'manager')
    await addTeamMember(restA.id, staff.id,   'staff')

    // A second restaurant with its own owner, for the cross-restaurant guard.
    const ownerB = await makeCustomer({ suiteNo: 30, name: 'Other Owner' })
    const restB  = await makeRestaurant({ ownerId: ownerB.id, label: 'menu_b', whatsapp: ownerB.phone })
    const itemB  = await makeMenuItem(restB.id, { name: 'B-only item', price: 1500 })

    const cookies = {
      owner:    customerCookie(owner),
      manager:  customerCookie(manager),
      staff:    customerCookie(staff),
      outsider: customerCookie(outsider),
    }

    const createItem = (restaurantId: string, body: Record<string, unknown>, cookie: string | null) =>
      api<ItemBody>(`/api/restaurants/${restaurantId}/menu`, {
        method: 'POST', body, ...(cookie ? { cookie } : {}),
      })
    const patchItem = (restaurantId: string, itemId: string, body: Record<string, unknown>, cookie: string | null) =>
      api<ItemBody>(`/api/restaurants/${restaurantId}/menu/${itemId}`, {
        method: 'PATCH', body, ...(cookie ? { cookie } : {}),
      })
    const deleteItem = (restaurantId: string, itemId: string, cookie: string | null) =>
      api<ItemBody>(`/api/restaurants/${restaurantId}/menu/${itemId}`, {
        method: 'DELETE', ...(cookie ? { cookie } : {}),
      })

    // Anything the API creates has to be tracked by hand — the fixtures never
    // saw it, so without this the ledger can't clean it (and the audit_log
    // rows keyed to it would survive too).
    const trackItem = (b: ItemBody): string => {
      const id = b.item?.id ?? ''
      if (id) track('menu_items', id)
      return id
    }

    // Ids kept for the audit assertions at the end.
    const auditIds: Record<string, string> = {}

    // ── 1. CREATE ──────────────────────────────────────────────────────────
    await step('owner creates a menu item', async () => {
      const r = await createItem(restA.id, { name: 'Ndolé maison', price: 2500, category: 'Plats' }, cookies.owner)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.ok, true, 'ok=true')
      const id = trackItem(r.body)
      auditIds.created = id
      assert(!!id, 'the created item came back with an id')
      assertEq(r.body.item?.name, 'Ndolé maison', 'name echoed back')
      assertEq(r.body.item?.price, 2500, 'price echoed back')
      assertEq(r.body.item?.restaurant_id, restA.id, 'restaurant_id is the one from the URL')

      const { data } = await sb.from('menu_items').select('name, price, category, is_available').eq('id', id).maybeSingle()
      const row = data as { name: string; price: number; category: string; is_available: boolean } | null
      assert(!!row, 'the row exists in menu_items')
      assertEq(row?.name, 'Ndolé maison', 'persisted name')
      assertEq(row?.price, 2500, 'persisted price')
      assertEq(row?.category, 'Plats', 'persisted category')
      assertEq(row?.is_available, true, 'is_available defaults to true')
    })

    await step('restaurant_id comes from the URL, never the body', async () => {
      // The form still sends restaurant_id; the route builds its row literally
      // so the body value has no path in. Send restaurant B's id while posting
      // to restaurant A and assert the item lands on A.
      const r = await createItem(restA.id, {
        name: 'URL wins', price: 1000, restaurant_id: restB.id, id: 'pwned',
      }, cookies.owner)
      assertEq(r.status, 200, 'HTTP 200')
      const id = trackItem(r.body)
      assertEq(r.body.item?.restaurant_id, restA.id, 'response says restaurant A')

      const { data } = await sb.from('menu_items').select('restaurant_id').eq('id', id).maybeSingle()
      assertEq((data as { restaurant_id?: string } | null)?.restaurant_id, restA.id,
        'the stored row belongs to restaurant A, not the body-supplied B')

      const { count } = await sb.from('menu_items')
        .select('*', { count: 'exact' }).eq('restaurant_id', restB.id).eq('name', 'URL wins').limit(0)
      assertEq(count ?? 0, 0, 'nothing was written to restaurant B')
    })

    await step('category defaults to Autre when omitted', async () => {
      const r = await createItem(restA.id, { name: 'No category', price: 900 }, cookies.owner)
      assertEq(r.status, 200, 'HTTP 200')
      trackItem(r.body)
      assertEq(r.body.item?.category, 'Autre', "category defaults to 'Autre'")
    })

    await step('manager can create', async () => {
      const r = await createItem(restA.id, { name: 'Manager item', price: 1200 }, cookies.manager)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      trackItem(r.body)
    })

    // ── 2. UPDATE ──────────────────────────────────────────────────────────
    await step('owner edits an item and the change persists', async () => {
      const created = await createItem(restA.id, { name: 'Before', price: 1000 }, cookies.owner)
      const id = trackItem(created.body)
      auditIds.updated = id

      const r = await patchItem(restA.id, id, { name: 'After', price: 3000 }, cookies.owner)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.item?.name, 'After', 'response carries the new name')

      const { data } = await sb.from('menu_items').select('name, price').eq('id', id).maybeSingle()
      const row = data as { name: string; price: number } | null
      assertEq(row?.name, 'After', 'persisted name changed')
      assertEq(row?.price, 3000, 'persisted price changed')
    })

    await step('the availability toggle works on its own', async () => {
      const created = await createItem(restA.id, { name: 'Toggle me', price: 800 }, cookies.owner)
      const id = trackItem(created.body)

      const off = await patchItem(restA.id, id, { is_available: false }, cookies.owner)
      assertEq(off.status, 200, 'HTTP 200 turning it off')
      assertEq(off.body.item?.is_available, false, 'response says unavailable')
      const { data: d1 } = await sb.from('menu_items').select('is_available, name').eq('id', id).maybeSingle()
      assertEq((d1 as { is_available?: boolean } | null)?.is_available, false, 'persisted as unavailable')
      assertEq((d1 as { name?: string } | null)?.name, 'Toggle me', 'a partial PATCH leaves other fields alone')

      const on = await patchItem(restA.id, id, { is_available: true }, cookies.owner)
      assertEq(on.status, 200, 'HTTP 200 turning it back on')
      const { data: d2 } = await sb.from('menu_items').select('is_available').eq('id', id).maybeSingle()
      assertEq((d2 as { is_available?: boolean } | null)?.is_available, true, 'persisted as available again')
    })

    await step('manager can update', async () => {
      const created = await createItem(restA.id, { name: 'Manager edits', price: 700 }, cookies.owner)
      const id = trackItem(created.body)
      const r = await patchItem(restA.id, id, { price: 750 }, cookies.manager)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.item?.price, 750, 'manager\'s edit applied')
    })

    // ── 3. DELETE ──────────────────────────────────────────────────────────
    await step('owner deletes an item and the row is gone', async () => {
      const created = await createItem(restA.id, { name: 'Delete me', price: 600 }, cookies.owner)
      const id = trackItem(created.body)
      auditIds.deleted = id

      const r = await deleteItem(restA.id, id, cookies.owner)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.ok, true, 'ok=true')

      const { data } = await sb.from('menu_items').select('id').eq('id', id).maybeSingle()
      assertEq(data, null, 'the row is gone from menu_items')
    })

    await step('manager can delete', async () => {
      const created = await createItem(restA.id, { name: 'Manager deletes', price: 500 }, cookies.owner)
      const id = trackItem(created.body)
      const r = await deleteItem(restA.id, id, cookies.manager)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      const { data } = await sb.from('menu_items').select('id').eq('id', id).maybeSingle()
      assertEq(data, null, 'the row is gone')
    })

    // ── 4. AUTHZ ───────────────────────────────────────────────────────────
    // A live item to aim the update/delete attempts at. It must survive every
    // refused call — that is half the assertion.
    const guarded = await createItem(restA.id, { name: 'Guarded', price: 2000 }, cookies.owner)
    const guardedId = trackItem(guarded.body)

    await step('staff is refused on create, update and delete (view-only)', async () => {
      assertEq((await createItem(restA.id, { name: 'Staff create', price: 100 }, cookies.staff)).status, 403,
        'POST → 403')
      assertEq((await patchItem(restA.id, guardedId, { price: 1 }, cookies.staff)).status, 403,
        'PATCH → 403')
      assertEq((await deleteItem(restA.id, guardedId, cookies.staff)).status, 403,
        'DELETE → 403')

      const { data } = await sb.from('menu_items').select('price').eq('id', guardedId).maybeSingle()
      assertEq((data as { price?: number } | null)?.price, 2000, 'the item is untouched after the refusals')
    })

    await step('a logged-in outsider is refused', async () => {
      assertEq((await createItem(restA.id, { name: 'Outsider create', price: 100 }, cookies.outsider)).status, 403,
        'POST → 403')
      assertEq((await patchItem(restA.id, guardedId, { price: 1 }, cookies.outsider)).status, 403,
        'PATCH → 403')
      assertEq((await deleteItem(restA.id, guardedId, cookies.outsider)).status, 403,
        'DELETE → 403')
    })

    await step('no session is refused with 401, not 403', async () => {
      assertEq((await createItem(restA.id, { name: 'Anon create', price: 100 }, null)).status, 401,
        'POST → 401')
      assertEq((await patchItem(restA.id, guardedId, { price: 1 }, null)).status, 401,
        'PATCH → 401')
      assertEq((await deleteItem(restA.id, guardedId, null)).status, 401,
        'DELETE → 401')

      const { data } = await sb.from('menu_items').select('price').eq('id', guardedId).maybeSingle()
      assertEq((data as { price?: number } | null)?.price, 2000, 'still untouched after the anonymous attempts')
    })

    await step("cross-restaurant: another restaurant's item is unreachable", async () => {
      // Authorized restaurant in the URL, foreign item id: the row is read
      // back matching BOTH id AND restaurant_id, so it simply isn't found.
      assertEq((await patchItem(restA.id, itemB.id, { price: 1 }, cookies.owner)).status, 404,
        'PATCH A/menu/{itemB} → 404 (scoping guard)')
      assertEq((await deleteItem(restA.id, itemB.id, cookies.owner)).status, 404,
        'DELETE A/menu/{itemB} → 404 (scoping guard)')

      // The other angle: foreign restaurant in the URL is refused by the gate
      // before scoping is even consulted.
      assertEq((await patchItem(restB.id, itemB.id, { price: 1 }, cookies.owner)).status, 403,
        'PATCH B/menu/{itemB} → 403 (authz gate)')
      assertEq((await deleteItem(restB.id, itemB.id, cookies.owner)).status, 403,
        'DELETE B/menu/{itemB} → 403 (authz gate)')
      assertEq((await createItem(restB.id, { name: 'Cross create', price: 100 }, cookies.owner)).status, 403,
        'POST to B → 403 (authz gate)')

      const { data } = await sb.from('menu_items').select('price, name').eq('id', itemB.id).maybeSingle()
      const row = data as { price: number; name: string } | null
      assert(!!row, "restaurant B's item still exists")
      assertEq(row?.price, 1500, "and its price is unchanged")
    })

    // ── 5. VALIDATION ──────────────────────────────────────────────────────
    await step('create validation', async () => {
      assertEq((await createItem(restA.id, { price: 1000 }, cookies.owner)).status, 400, 'missing name → 400')
      assertEq((await createItem(restA.id, { name: '   ', price: 1000 }, cookies.owner)).status, 400,
        'whitespace-only name → 400')
      assertEq((await createItem(restA.id, { name: 'Neg', price: -5 }, cookies.owner)).status, 400,
        'negative price → 400')
      assertEq((await createItem(restA.id, { name: 'NaN', price: 'abc' }, cookies.owner)).status, 400,
        'non-numeric price → 400')
      assertEq((await createItem(restA.id, { name: 'NoPrice' }, cookies.owner)).status, 400,
        'missing price → 400')
      // Zero is legal — a free item is a real thing on a menu.
      const free = await createItem(restA.id, { name: 'Free water', price: 0 }, cookies.owner)
      assertEq(free.status, 200, 'price 0 → 200 (free items are allowed)')
      trackItem(free.body)
    })

    await step('update validation', async () => {
      assertEq((await patchItem(restA.id, guardedId, { name: '' }, cookies.owner)).status, 400,
        'blank name → 400')
      assertEq((await patchItem(restA.id, guardedId, { price: -1 }, cookies.owner)).status, 400,
        'negative price → 400')
      assertEq((await patchItem(restA.id, guardedId, { is_available: 'yes' }, cookies.owner)).status, 400,
        'non-boolean is_available → 400')
      assertEq((await patchItem(restA.id, guardedId, {}, cookies.owner)).status, 400,
        'empty patch → 400')

      const { data } = await sb.from('menu_items').select('price').eq('id', guardedId).maybeSingle()
      assertEq((data as { price?: number } | null)?.price, 2000, 'no rejected update leaked through')
    })

    // ── 6. AUDIT ───────────────────────────────────────────────────────────
    await step('create, update and delete each write an audit row', async () => {
      const checks: Array<[string, string]> = [
        ['menu_item_created', auditIds.created],
        ['menu_item_updated', auditIds.updated],
        ['menu_item_deleted', auditIds.deleted],
      ]
      for (const [action, targetId] of checks) {
        const { data } = await sb.from('audit_log')
          .select('action, target_id, target_type, metadata')
          .eq('target_id', targetId).eq('action', action).limit(1).maybeSingle()
        assert(!!data, `${action} audit row exists`)
        const row = data as { target_type?: string; metadata?: { restaurant_id?: string } } | null
        assertEq(row?.target_type, 'menu_item', `${action} target_type=menu_item`)
        assertEq(row?.metadata?.restaurant_id, restA.id, `${action} metadata names the restaurant`)
      }
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
