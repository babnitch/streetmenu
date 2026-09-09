// TEST-PLAN.md §1d #45-#51 — the WhatsApp router, complete.
// #45/#50/#51 customer, identity and session; #46-#49 vendor management.
//
// MECHANISM. The webhook is a plain form-POST and answers 200 to anything it
// accepts, so a status code proves almost nothing here: an accepted command, a
// refused one and a rate-limited one all look identical from outside. Every
// assertion below is therefore about DATABASE EFFECT — the row changed, or
// provably did not — never about message delivery. Only the outbound Twilio
// leg needs credentials, and it fails harmlessly against +999 numbers.
//
// Signature validation is skipped because TWILIO_AUTH_TOKEN is unset
// (route.ts:399 warns and continues), which is why this harness can post
// directly. If that variable is ever added to .env.local these suites will
// start receiving 403s — that is the expected failure, not a regression.
//
// 🔴 RATE LIMIT — the trap this suite is written around. route.ts:405 allows
// 100 messages per phone per minute and, when tripped, returns 200 having done
// NOTHING. That is byte-identical to a refusal. So:
//
//   * commands are spread across per-role phones, none near the cap; and
//   * every REFUSAL assertion is followed by a POSITIVE CONTROL from the SAME
//     phone — a command that must succeed and whose effect is visible in the
//     database. If the control also fails, the phone was throttled and the
//     "refusal" proved nothing.
//
// A throttled 200 masquerading as a gate is the one way this suite could go
// green while testing nothing, and the control is what forecloses it.
//
// SAFETY: no subscriber fan-out is reachable from this router.
// notifyEventSubscribers appears only in events/submit and admin approve,
// neither of which any of these commands can reach — so the namespaced-city
// machinery from api-events is not needed. Phones and names still use the
// reserved namespace so the sweeper can see anything left behind.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem, makeOrder, addTeamMember, type TestCustomer } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-whatsapp-router'

// One inbound WhatsApp message. Always 200 when the webhook accepts it.
const send = (phone: string, body: string) =>
  api('/api/whatsapp/incoming', { form: { From: `whatsapp:${phone}`, Body: body } })

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function langOf(customerId: string): Promise<string | null> {
  const { data } = await sb.from('customers').select('preferred_language').eq('id', customerId).maybeSingle()
  return (data as { preferred_language?: string | null } | null)?.preferred_language ?? null
}

async function sessionsFor(phone: string): Promise<number> {
  const { data } = await sb.from('signup_sessions').select('phone').eq('phone', phone)
  return (data ?? []).length
}

async function subsFor(customerId: string) {
  const { data } = await sb.from('event_subscriptions')
    .select('id, city, is_active, unsubscribed_at').eq('customer_id', customerId)
  return (data ?? []) as Array<{ id: string; city: string; is_active: boolean; unsubscribed_at: string | null }>
}

/**
 * Proves a phone is not rate-limited, by making it do something with a
 * visible database effect and checking the effect landed. Used immediately
 * after every refusal assertion — see the header note.
 */
async function assertNotThrottled(customer: TestCustomer, label: string): Promise<void> {
  const before = await langOf(customer.id)
  const target = before === 'en' ? 'fr' : 'en'
  await send(customer.phone, target)
  const after = await langOf(customer.id)
  assertEq(after, target,
    `${label}: control command from the same phone still works — the refusal above was a gate, not a throttle`)
}

async function main(): Promise<void> {
  try {
    // ══ #45 LANGUAGE + HELP ════════════════════════════════════════════════

    await step('#45 en / fr flip customers.preferred_language', async () => {
      const c = await makeCustomer({ suiteNo: 45, name: 'Lang Customer' })

      await send(c.phone, 'en')
      assertEq(await langOf(c.id), 'en', "'en' sets preferred_language to en")

      await send(c.phone, 'fr')
      assertEq(await langOf(c.id), 'fr', "'fr' sets it back to fr")

      // The aliases the handler accepts.
      await send(c.phone, 'english')
      assertEq(await langOf(c.id), 'en', "'english' is an alias for en")
      await send(c.phone, 'francais')
      assertEq(await langOf(c.id), 'fr', "'francais' is an alias for fr")
      await send(c.phone, 'anglais')
      assertEq(await langOf(c.id), 'en', "'anglais' is an alias for en too")

      assertEq(await sessionsFor(c.phone), 0, 'and none of it left a signup_sessions row behind')
    })

    await step('#45 aide / aide+ are read-only', async () => {
      const c = await makeCustomer({ suiteNo: 45, name: 'Help Customer' })
      await send(c.phone, 'fr')
      const langBefore = await langOf(c.id)

      for (const cmd of ['aide', 'help', 'aide+', 'help+', '']) {
        const r = await send(c.phone, cmd)
        assertEq(r.status, 200, `'${cmd || '<empty>'}' is accepted`)
      }
      assertEq(await langOf(c.id), langBefore, 'help never changes the stored language')
      assertEq(await sessionsFor(c.phone), 0, 'and opens no session')
    })

    await step('#45 an unknown command changes nothing', async () => {
      const c = await makeCustomer({ suiteNo: 45, name: 'Noise Customer' })
      await send(c.phone, 'fr')
      const r = await send(c.phone, 'zzz totally unknown command zzz')
      assertEq(r.status, 200, 'the webhook still answers 200')
      assertEq(await langOf(c.id), 'fr', 'the language is untouched')
      assertEq(await sessionsFor(c.phone), 0, 'and no session was opened')
    })

    // ══ #51 SESSION CONTROL ════════════════════════════════════════════════

    await step('#51 reset clears every session row for the phone', async () => {
      const c = await makeCustomer({ suiteNo: 51, name: 'Reset Customer' })

      // Open a real session the way a user would, then confirm it exists.
      await send(c.phone, 'commander')
      await sleep(300)
      assert(await sessionsFor(c.phone) > 0, 'the ordering flow opened a session')

      await send(c.phone, 'reset')
      assertEq(await sessionsFor(c.phone), 0, "'reset' removed it")

      // Aliases, each proven against a freshly-opened session.
      for (const alias of ['reinitialiser', 'exit', 'quitter', 'stop']) {
        await send(c.phone, 'commander')
        await sleep(300)
        assert(await sessionsFor(c.phone) > 0, `session reopened before '${alias}'`)
        await send(c.phone, alias)
        assertEq(await sessionsFor(c.phone), 0, `'${alias}' clears the session too`)
      }
    })

    await step('#51 annuler clears a non-ordering session', async () => {
      const c = await makeCustomer({ suiteNo: 51, name: 'Cancel Customer' })

      // A non-ordering flow: the subscription wizard.
      await send(c.phone, 'abonner')
      await sleep(300)
      const opened = await sessionsFor(c.phone)

      await send(c.phone, 'annuler')
      assertEq(await sessionsFor(c.phone), 0,
        `'annuler' cleared the non-ordering session (there ${opened > 0 ? 'was' : 'was no'} one open)`)

      await send(c.phone, 'abonner')
      await sleep(300)
      await send(c.phone, 'cancel')
      assertEq(await sessionsFor(c.phone), 0, "'cancel' is the English alias")

      assertEq(await sessionsFor(c.phone), 0, 'no residue either way')
    })

    await step('#51 reset works from a clean slate without erroring', async () => {
      const c = await makeCustomer({ suiteNo: 51, name: 'Idempotent Reset' })
      assertEq(await sessionsFor(c.phone), 0, 'starts with no session')
      const r = await send(c.phone, 'reset')
      assertEq(r.status, 200, 'reset on nothing is still accepted')
      assertEq(await sessionsFor(c.phone), 0, 'and leaves nothing behind')
    })

    // ══ #50 READ PATHS + UNSUBSCRIBE ═══════════════════════════════════════

    await step('#50 mes commandes is a read — it changes no order', async () => {
      const c = await makeCustomer({ suiteNo: 50, name: 'Orders Customer' })
      const owner = await makeCustomer({ suiteNo: 50, name: 'Orders Owner' })
      const rest = await makeRestaurant({ ownerId: owner.id, label: 'wa_orders', whatsapp: owner.phone })
      const order = await makeOrder(rest.id, c, { status: 'pending' })

      const r = await send(c.phone, 'mes commandes')
      assertEq(r.status, 200, 'accepted')
      const { data } = await sb.from('orders').select('status').eq('id', order.id).maybeSingle()
      assertEq((data as { status?: string } | null)?.status, 'pending', 'the order status is untouched')
      assertEq(await sessionsFor(c.phone), 0, 'and no session was opened')

      const en = await send(c.phone, 'my orders')
      assertEq(en.status, 200, "'my orders' is the English alias")
    })

    await step('#50 mes restaurants lists a vendor’s restaurants without mutating them', async () => {
      const vendor = await makeCustomer({ suiteNo: 50, name: 'Multi Vendor' })
      const r1 = await makeRestaurant({ ownerId: vendor.id, label: 'wa_multi_1', whatsapp: vendor.phone })
      // A second restaurant reached through a team row, so the sender has two.
      const otherOwner = await makeCustomer({ suiteNo: 50, name: 'Other Owner' })
      const r2 = await makeRestaurant({ ownerId: otherOwner.id, label: 'wa_multi_2', whatsapp: otherOwner.phone })
      await addTeamMember(r2.id, vendor.id, 'manager')

      const before = await sb.from('restaurants').select('id, name, is_open, status')
        .in('id', [r1.id, r2.id]).order('id')
      const res = await send(vendor.phone, 'mes restaurants')
      assertEq(res.status, 200, 'accepted')

      const after = await sb.from('restaurants').select('id, name, is_open, status')
        .in('id', [r1.id, r2.id]).order('id')
      assertEq(after.data, before.data, 'neither restaurant row changed — it is a pure read')
    })

    await step('#50 mes abonnements reads, desabonner writes', async () => {
      const c = await makeCustomer({ suiteNo: 50, name: 'Subs Customer' })
      const city = testName('subcity')

      // Seed a subscription directly — the subscribe wizard is its own flow.
      const { data: created, error } = await sb.from('event_subscriptions').insert({
        customer_id: c.id, city, categories: null, is_active: true,
      } as never).select('id').single()
      assert(!error, `seeded a subscription${error ? ` — ${error.message}` : ''}`)
      track('event_subscriptions', (created as unknown as { id: string }).id)

      // Read path leaves it alone.
      const listed = await send(c.phone, 'mes abonnements')
      assertEq(listed.status, 200, "'mes abonnements' accepted")
      let subs = await subsFor(c.id)
      assertEq(subs.length, 1, 'still exactly one subscription')
      assertEq(subs[0]?.is_active, true, 'and it is still active — listing does not mutate')

      const listedEn = await send(c.phone, 'my subscriptions')
      assertEq(listedEn.status, 200, "'my subscriptions' is the English alias")
      assertEq((await subsFor(c.id))[0]?.is_active, true, 'still active')

      // Write path deactivates rather than deleting.
      await send(c.phone, 'desabonner')
      subs = await subsFor(c.id)
      assertEq(subs.length, 1, 'the row still EXISTS — unsubscribe is a deactivation')
      assertEq(subs[0]?.is_active, false, 'is_active flipped to false')
      assert(!!subs[0]?.unsubscribed_at, 'and unsubscribed_at was stamped')
    })

    await step('#50 desabonner is safe to repeat and safe with nothing subscribed', async () => {
      const c = await makeCustomer({ suiteNo: 50, name: 'No Subs Customer' })
      const r = await send(c.phone, 'desabonner')
      assertEq(r.status, 200, 'unsubscribing with no subscription is accepted')
      assertEq((await subsFor(c.id)).length, 0, 'and creates nothing')

      const en = await send(c.phone, 'unsubscribe')
      assertEq(en.status, 200, "'unsubscribe' is the English alias")
      assertEq((await subsFor(c.id)).length, 0, 'still nothing')
    })

    // ══ IDENTITY / AUTHZ ═══════════════════════════════════════════════════

    await step('a vendor command from a NON-VENDOR phone does nothing', async () => {
      // A plain customer with no restaurant and no team row.
      const outsider = await makeCustomer({ suiteNo: 45, name: 'Plain Customer' })
      const owner    = await makeCustomer({ suiteNo: 46, name: 'Real Owner' })
      const rest = await makeRestaurant({
        ownerId: owner.id, label: 'wa_not_yours', whatsapp: owner.phone,
        extra: { manual_override: null },
      })

      const before = await sb.from('restaurants')
        .select('is_open, manual_override, status').eq('id', rest.id).maybeSingle()

      // Vendor-only commands sent by someone with no vendor identity at all.
      for (const cmd of ['ouvrir', 'fermer', 'equipe', 'commandes']) {
        const r = await send(outsider.phone, cmd)
        assertEq(r.status, 200, `'${cmd}' is accepted by the webhook (it answers 200 regardless)`)
      }

      const after = await sb.from('restaurants')
        .select('is_open, manual_override, status').eq('id', rest.id).maybeSingle()
      assertEq(after.data, before.data,
        'and NOT ONE of them touched the restaurant — the sender has no vendor identity')

      // Positive control from the same phone: prove it was never throttled.
      await assertNotThrottled(outsider, 'non-vendor refusal')
    })

    await step('a vendor cannot reach a restaurant they have no role on', async () => {
      const vendorA = await makeCustomer({ suiteNo: 46, name: 'Vendor A' })
      const vendorB = await makeCustomer({ suiteNo: 46, name: 'Vendor B' })
      const restA = await makeRestaurant({ ownerId: vendorA.id, label: 'wa_scope_a', whatsapp: vendorA.phone })
      const restB = await makeRestaurant({ ownerId: vendorB.id, label: 'wa_scope_b', whatsapp: vendorB.phone })

      const beforeB = await sb.from('restaurants')
        .select('is_open, manual_override, name').eq('id', restB.id).maybeSingle()

      // A's phone is resolved to A's restaurant; there is no addressing scheme
      // that lets one vendor aim a command at another's restaurant.
      await send(vendorA.phone, 'fermer')

      const afterB = await sb.from('restaurants')
        .select('is_open, manual_override, name').eq('id', restB.id).maybeSingle()
      assertEq(afterB.data, beforeB.data, "B's restaurant is untouched by A's command")

      // A's own restaurant DID change — which is the control proving the
      // command itself works and A's phone is not throttled.
      const afterA = await sb.from('restaurants')
        .select('manual_override').eq('id', restA.id).maybeSingle()
      assertEq((afterA.data as { manual_override?: string | null } | null)?.manual_override, 'closed',
        "A's OWN restaurant did close — the command works, it is simply scoped to the sender")
    })

    await step('an unregistered sender is onboarded, not given vendor powers', async () => {
      const unknownPhone = '+999459999'   // never registered
      const owner = await makeCustomer({ suiteNo: 45, name: 'Untouched Owner' })
      const rest  = await makeRestaurant({
        ownerId: owner.id, label: 'wa_unknown', whatsapp: owner.phone,
        extra: { manual_override: null },
      })
      const before = await sb.from('restaurants')
        .select('is_open, manual_override').eq('id', rest.id).maybeSingle()

      const r = await send(unknownPhone, 'ouvrir')
      assertEq(r.status, 200, 'an unregistered phone is still answered')

      // A vendor command from an unknown number does NOT do vendor things.
      const after = await sb.from('restaurants')
        .select('is_open, manual_override').eq('id', rest.id).maybeSingle()
      assertEq(after.data, before.data, 'no restaurant was touched')
      const { data: cust } = await sb.from('customers').select('id').eq('phone', unknownPhone).maybeSingle()
      assertEq(cust, null, 'and no customer row was created')

      // What it DOES do is start the signup wizard — route.ts:600, "Brand-new
      // user → start customer signup". The command text is irrelevant; any
      // message from an unknown number lands here.
      const { data: sess } = await sb.from('signup_sessions')
        .select('user_type, step').eq('phone', unknownPhone).maybeSingle()
      assert(!!sess, 'a signup session was opened instead')
      assertEq((sess as { user_type?: string } | null)?.user_type, 'customer', "user_type='customer'")
      assertEq((sess as { step?: number } | null)?.step, 1, 'at step 1, asking for a name')

      // And the escape hatch clears it, leaving nothing behind.
      await send(unknownPhone, 'annuler')
      assertEq(await sessionsFor(unknownPhone), 0, "'annuler' abandons the signup cleanly")
    })
    // ══ #46 ouvrir / fermer / auto ═════════════════════════════════════════

    // Whole-row snapshot: the toggle mirrors POST /override, so manual_override
    // moves and is_open must NOT — is_open belongs to the separate /open route.
    const restaurantRow = async (id: string): Promise<Record<string, unknown>> => {
      const { data } = await sb.from('restaurants').select('*').eq('id', id).maybeSingle()
      return (data ?? {}) as Record<string, unknown>
    }
    const diffKeys = (before: Record<string, unknown>, after: Record<string, unknown>): string[] => {
      const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
      return keys.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    }

    await step('#46 ouvrir / fermer / auto move manual_override and nothing else', async () => {
      const owner = await makeCustomer({ suiteNo: 46, name: 'Toggle Owner' })
      const rest  = await makeRestaurant({
        ownerId: owner.id, label: 'wa_toggle', whatsapp: owner.phone,
        extra: { manual_override: null, manual_override_at: null },
      })

      const before = await restaurantRow(rest.id)
      await send(owner.phone, 'fermer')
      const closed = await restaurantRow(rest.id)

      assertEq(closed.manual_override, 'closed', "'fermer' sets manual_override='closed'")
      assert(closed.manual_override_at !== null, 'and stamps manual_override_at')
      assertEq(closed.is_open, before.is_open,
        'is_open is UNCHANGED — this mirrors /override, not /open')
      const changed = diffKeys(before, closed).filter(k => k !== 'updated_at')
      assertEq(changed.sort(), ['manual_override', 'manual_override_at'],
        `only those two columns moved (got: ${changed.join(', ')})`)

      await send(owner.phone, 'ouvrir')
      assertEq((await restaurantRow(rest.id)).manual_override, 'open', "'ouvrir' sets it to 'open'")

      await send(owner.phone, 'auto')
      const auto = await restaurantRow(rest.id)
      assertEq(auto.manual_override, null, "'auto' clears the override")
      assertEq(auto.manual_override_at, null, 'and clears the timestamp with it')
      assertEq(auto.is_open, before.is_open, 'is_open still untouched across the whole cycle')

      // English aliases.
      await send(owner.phone, 'close')
      assertEq((await restaurantRow(rest.id)).manual_override, 'closed', "'close' is the English alias")
      await send(owner.phone, 'open')
      assertEq((await restaurantRow(rest.id)).manual_override, 'open', "'open' is the English alias")
    })

    await step('#46 manager can toggle, staff cannot', async () => {
      const owner   = await makeCustomer({ suiteNo: 46, name: 'Gate Owner' })
      const manager = await makeCustomer({ suiteNo: 46, name: 'Gate Manager' })
      const staff   = await makeCustomer({ suiteNo: 46, name: 'Gate Staff' })
      const rest = await makeRestaurant({
        ownerId: owner.id, label: 'wa_toggle_gate', whatsapp: owner.phone,
        extra: { manual_override: null, manual_override_at: null },
      })
      await addTeamMember(rest.id, manager.id, 'manager')
      await addTeamMember(rest.id, staff.id,   'staff')

      await send(manager.phone, 'fermer')
      assertEq((await restaurantRow(rest.id)).manual_override, 'closed', 'a manager CAN close')

      await send(owner.phone, 'auto')
      const beforeStaff = await restaurantRow(rest.id)
      assertEq(beforeStaff.manual_override, null, 'reset to auto before the staff attempt')

      await send(staff.phone, 'fermer')
      const afterStaff = await restaurantRow(rest.id)
      assertEq(afterStaff.manual_override, null, 'staff CANNOT close — override still null')
      assertEq(diffKeys(beforeStaff, afterStaff).filter(k => k !== 'updated_at'), [],
        'the staff attempt changed nothing at all')

      // The refusal must be a gate, not a throttle.
      await assertNotThrottled(staff, '#46 staff toggle refusal')
    })

    // ══ #47 horaires — READ ONLY ═══════════════════════════════════════════

    await step('#47 horaires reflects stored hours and writes nothing', async () => {
      const owner = await makeCustomer({ suiteNo: 47, name: 'Hours Owner' })
      const rest  = await makeRestaurant({
        ownerId: owner.id, label: 'wa_hours', whatsapp: owner.phone,
        extra: { manual_override: null },
      })

      // Seed a week directly — there is no WhatsApp schedule-writer; that is
      // POST /hours, covered by api-hours-and-open.
      const week = [0, 1, 2, 3, 4, 5, 6].map(d => ({
        restaurant_id: rest.id, day_of_week: d,
        open_time: '08:00', close_time: '18:00', is_closed: false,
      }))
      const { error } = await sb.from('restaurant_hours').insert(week as never)
      assert(!error, `seeded a 7-day schedule${error ? ` — ${error.message}` : ''}`)

      const hoursBefore = await sb.from('restaurant_hours')
        .select('day_of_week, open_time, close_time, is_closed')
        .eq('restaurant_id', rest.id).order('day_of_week')
      const restBefore = await restaurantRow(rest.id)

      for (const cmd of ['horaires', 'horaire', 'schedule', 'hours']) {
        const r = await send(owner.phone, cmd)
        assertEq(r.status, 200, `'${cmd}' is accepted`)
      }

      const hoursAfter = await sb.from('restaurant_hours')
        .select('day_of_week, open_time, close_time, is_closed')
        .eq('restaurant_id', rest.id).order('day_of_week')
      assertEq(hoursAfter.data, hoursBefore.data, 'NOT ONE schedule row changed — horaires is read-only')
      assertEq(diffKeys(restBefore, await restaurantRow(rest.id)).filter(k => k !== 'updated_at'), [],
        'and the restaurant row is untouched too')
      assertEq(await sessionsFor(owner.phone), 0, 'it opens no session — there is no multi-step flow here')

      // It does read the override: set one and the command still writes nothing.
      await send(owner.phone, 'fermer')
      const afterOverride = await sb.from('restaurant_hours')
        .select('day_of_week, open_time, close_time, is_closed')
        .eq('restaurant_id', rest.id).order('day_of_week')
      await send(owner.phone, 'horaires')
      assertEq((await sb.from('restaurant_hours')
        .select('day_of_week, open_time, close_time, is_closed')
        .eq('restaurant_id', rest.id).order('day_of_week')).data,
        afterOverride.data, 'still read-only with an override in force')
    })

    // ══ #48 menu + add-item ════════════════════════════════════════════════

    const itemsFor = async (restaurantId: string) => {
      const { data } = await sb.from('menu_items')
        .select('id, name, price, category, is_available').eq('restaurant_id', restaurantId)
      return (data ?? []) as Array<{ id: string; name: string; price: number; category: string; is_available: boolean }>
    }

    await step('#48 the 3-part add-item syntax creates a menu item', async () => {
      const owner = await makeCustomer({ suiteNo: 48, name: 'Menu Owner' })
      const rest  = await makeRestaurant({ ownerId: owner.id, label: 'wa_menu3', whatsapp: owner.phone })

      await send(owner.phone, 'Ndolé WA - 2500 - Plats')
      const items = await itemsFor(rest.id)
      for (const i of items) track('menu_items', i.id)
      assertEq(items.length, 1, 'one item was created')
      assertEq(items[0]?.name, 'Ndolé WA', 'with the dish name')
      assertEq(items[0]?.price, 2500, 'and the price')
      assert(!!items[0]?.category, `and a resolved category (got ${items[0]?.category})`)
      assertEq(items[0]?.is_available, true, 'available by default')
      assertEq(await sessionsFor(owner.phone), 0, 'the 3-part form completes without a session')
    })

    await step('#48 the 2-part syntax stashes a session and asks for a category', async () => {
      const owner = await makeCustomer({ suiteNo: 48, name: 'Menu Owner 2' })
      const rest  = await makeRestaurant({ ownerId: owner.id, label: 'wa_menu2', whatsapp: owner.phone })

      await send(owner.phone, 'Eru WA - 2000')
      assertEq((await itemsFor(rest.id)).length, 0, 'nothing is inserted yet — it needs a category')
      const { data: sess } = await sb.from('signup_sessions')
        .select('user_type, step, data').eq('phone', owner.phone).maybeSingle()
      assert(!!sess, 'a session was opened to collect the category')
      assertEq((sess as { user_type?: string } | null)?.user_type, 'menu_category', "user_type='menu_category'")
      const stashed = (sess as { data?: { name?: string; price?: string } } | null)?.data
      assertEq(stashed?.name, 'Eru WA', 'the pending dish name is stashed')
      assertEq(stashed?.price, '2000', 'along with its price')

      // Answering the prompt completes the insert.
      await send(owner.phone, '1')
      const items = await itemsFor(rest.id)
      for (const i of items) track('menu_items', i.id)
      assertEq(items.length, 1, 'answering the category creates the item')
      assertEq(items[0]?.name, 'Eru WA', 'with the stashed name')
      assertEq(items[0]?.price, 2000, 'and the stashed price')
      assertEq(await sessionsFor(owner.phone), 0, 'and the session is consumed')
    })

    await step('#48 an invalid add-item price is rejected', async () => {
      const owner = await makeCustomer({ suiteNo: 48, name: 'Menu Owner 3' })
      const rest  = await makeRestaurant({ ownerId: owner.id, label: 'wa_menu_bad', whatsapp: owner.phone })

      await send(owner.phone, 'Zero Dish - 0 - Plats')
      assertEq((await itemsFor(rest.id)).length, 0, 'a zero price creates nothing')
      assertEq(await sessionsFor(owner.phone), 0, 'and opens no session')
    })

    await step('#48 STAFF cannot add a menu item — the WhatsApp side of the role gate', async () => {
      const owner = await makeCustomer({ suiteNo: 48, name: 'Menu Gate Owner' })
      const staff = await makeCustomer({ suiteNo: 48, name: 'Menu Gate Staff' })
      const rest  = await makeRestaurant({ ownerId: owner.id, label: 'wa_menu_gate', whatsapp: owner.phone })
      await addTeamMember(rest.id, staff.id, 'staff')

      await send(staff.phone, 'Forbidden Dish - 9999 - Plats')
      assertEq((await itemsFor(rest.id)).length, 0, 'NO menu item was created by staff')
      assertEq(await sessionsFor(staff.phone), 0, 'and no pending-category session either')

      await assertNotThrottled(staff, '#48 staff menu refusal')

      // Control: the same restaurant DOES accept the item from its owner, so
      // the refusal is about the role rather than the message or the data.
      await send(owner.phone, 'Allowed Dish - 9999 - Plats')
      const items = await itemsFor(rest.id)
      for (const i of items) track('menu_items', i.id)
      assertEq(items.length, 1, 'the owner CAN add the very same item')
      assertEq(items[0]?.name, 'Allowed Dish', 'proving the gate is on the role, not the payload')
    })

    await step('#48 menu is a read that changes nothing', async () => {
      const owner = await makeCustomer({ suiteNo: 48, name: 'Menu Reader' })
      const rest  = await makeRestaurant({ ownerId: owner.id, label: 'wa_menu_read', whatsapp: owner.phone })
      const created = await makeMenuItem(rest.id, { name: 'Readable', price: 1500 })

      const before = await itemsFor(rest.id)
      const r = await send(owner.phone, 'menu')
      assertEq(r.status, 200, "'menu' is accepted")
      assertEq(await itemsFor(rest.id), before, 'the menu is unchanged')
      assertEq((await itemsFor(rest.id))[0]?.id, created.id, 'and still lists the seeded item')
    })

    // ══ #49 equipe / invitations / accepter / refuser ══════════════════════

    const teamRowFor = async (restaurantId: string, customerId: string) => {
      const { data } = await sb.from('restaurant_team')
        .select('id, role, status').eq('restaurant_id', restaurantId).eq('customer_id', customerId).maybeSingle()
      return data as { id: string; role: string; status: string } | null
    }
    const invitesFor = async (restaurantId: string) => {
      const { data } = await sb.from('team_invitations')
        .select('id, phone, role, status').eq('restaurant_id', restaurantId)
      return (data ?? []) as Array<{ id: string; phone: string; role: string; status: string }>
    }

    await step('#49 equipe and invitations are owner-only reads', async () => {
      const owner   = await makeCustomer({ suiteNo: 49, name: 'Team WA Owner' })
      const manager = await makeCustomer({ suiteNo: 49, name: 'Team WA Manager' })
      const rest = await makeRestaurant({ ownerId: owner.id, label: 'wa_team_read', whatsapp: owner.phone })
      await addTeamMember(rest.id, manager.id, 'manager')

      const before = await sb.from('restaurant_team').select('id, role, status')
        .eq('restaurant_id', rest.id).order('id')

      for (const cmd of ['equipe', 'team', 'invitations', 'invitation']) {
        assertEq((await send(owner.phone, cmd)).status, 200, `owner: '${cmd}' accepted`)
      }
      assertEq((await sb.from('restaurant_team').select('id, role, status')
        .eq('restaurant_id', rest.id).order('id')).data, before.data,
        'none of the read commands changed the roster')

      // A manager is refused both — team management is owner-only.
      await send(manager.phone, 'equipe')
      await send(manager.phone, 'invitations')
      assertEq((await sb.from('restaurant_team').select('id, role, status')
        .eq('restaurant_id', rest.id).order('id')).data, before.data,
        'and the manager attempts changed nothing either')
      await assertNotThrottled(manager, '#49 manager team-read refusal')
    })

    await step('#49 ajouter adds a known customer; inviter creates a pending invitation', async () => {
      const owner = await makeCustomer({ suiteNo: 49, name: 'Invite WA Owner' })
      const known = await makeCustomer({ suiteNo: 49, name: 'Known Invitee WA' })
      const rest = await makeRestaurant({ ownerId: owner.id, label: 'wa_invite', whatsapp: owner.phone })

      // Known customer → straight into restaurant_team, no invitation row.
      await send(owner.phone, `ajouter ${known.phone} manager`)
      const row = await teamRowFor(rest.id, known.id)
      assert(!!row, 'a team row was created for the known customer')
      if (row) track('restaurant_team', row.id)
      assertEq(row?.role, 'manager', 'with the requested role')
      assertEq(row?.status, 'active', 'and active immediately')
      const invitesAfterAdd = await invitesFor(rest.id)
      assertEq(invitesAfterAdd.length, 0, 'and NO invitation row for the instant path')

      // Unknown number → a pending invitation instead.
      const unknownPhone = '+999499001'
      await send(owner.phone, `inviter ${unknownPhone} staff`)
      const invites = await invitesFor(rest.id)
      for (const i of invites) track('team_invitations', i.id)
      assertEq(invites.length, 1, 'one invitation row')
      assertEq(invites[0]?.status, 'pending', "status='pending'")
      assertEq(invites[0]?.role, 'staff', 'carrying the requested role')
      const { data: cust } = await sb.from('customers').select('id').eq('phone', unknownPhone).maybeSingle()
      assertEq(cust, null, 'and no customer row was created for the invitee')
    })

    await step('#49 refuser declines a pending invitation', async () => {
      const owner  = await makeCustomer({ suiteNo: 49, name: 'Decline Owner' })
      const invitee = await makeCustomer({ suiteNo: 49, name: 'Decline Invitee' })
      const rest = await makeRestaurant({ ownerId: owner.id, label: 'wa_decline', whatsapp: owner.phone })

      // Seed a pending invitation for an EXISTING customer so the reply path
      // does not divert into the registration wizard.
      const { data: inv, error } = await sb.from('team_invitations').insert({
        restaurant_id: rest.id, phone: invitee.phone, role: 'staff',
        invited_by: owner.id, status: 'pending',
      } as never).select('id').single()
      assert(!error, `seeded an invitation${error ? ` — ${error.message}` : ''}`)
      track('team_invitations', (inv as unknown as { id: string }).id)

      await send(invitee.phone, 'refuser')
      const after = await invitesFor(rest.id)
      assertEq(after[0]?.status, 'declined', "status flipped to 'declined'")
      assertEq(await teamRowFor(rest.id, invitee.id), null, 'and no team row was created')
    })

    await step('#49 accepter promotes an existing customer onto the team', async () => {
      const owner   = await makeCustomer({ suiteNo: 49, name: 'Accept Owner' })
      const invitee = await makeCustomer({ suiteNo: 49, name: 'Accept Invitee' })
      const rest = await makeRestaurant({ ownerId: owner.id, label: 'wa_accept', whatsapp: owner.phone })

      const { data: inv, error } = await sb.from('team_invitations').insert({
        restaurant_id: rest.id, phone: invitee.phone, role: 'manager',
        invited_by: owner.id, status: 'pending',
      } as never).select('id').single()
      assert(!error, `seeded an invitation${error ? ` — ${error.message}` : ''}`)
      track('team_invitations', (inv as unknown as { id: string }).id)

      await send(invitee.phone, 'accepter')
      const row = await teamRowFor(rest.id, invitee.id)
      assert(!!row, 'a restaurant_team row now exists')
      if (row) track('restaurant_team', row.id)
      assertEq(row?.role, 'manager', 'with the invited role')
      assertEq(row?.status, 'active', 'and active')
      assertEq((await invitesFor(rest.id))[0]?.status, 'accepted', "the invitation is marked 'accepted'")
    })

    await step('#49 accepter from an UNKNOWN number opens an invite_accept signup', async () => {
      // The flow that could never work before supabase-signup-session-types.sql:
      // signup_sessions_user_type_check rejected 'invite_accept', the upsert
      // swallowed the error, and the invitee was promised a registration that
      // was never stored. Their next message started a plain signup and the
      // invitation was orphaned. This is the proof it works now.
      const owner = await makeCustomer({ suiteNo: 49, name: 'Invite Unknown Owner' })
      const rest  = await makeRestaurant({ ownerId: owner.id, label: 'wa_invite_new', whatsapp: owner.phone })
      const newcomerPhone = '+999499500'

      // No customer exists for this number — that is what selects the
      // two-step branch rather than the instant one.
      const { data: pre } = await sb.from('customers').select('id').eq('phone', newcomerPhone).maybeSingle()
      assertEq(pre, null, 'the invitee is not a customer yet')

      // Self-contained on purpose: this step ships with the bug fix, ahead of
      // the rest of the #46-#49 coverage, so it borrows no shared helper.
      const readInvites = async () => {
        const { data } = await sb.from('team_invitations')
          .select('id, phone, role, status').eq('restaurant_id', rest.id)
        return (data ?? []) as Array<{ id: string; phone: string; role: string; status: string }>
      }

      await send(owner.phone, `inviter ${newcomerPhone} manager`)
      const invites = await readInvites()
      for (const i of invites) track('team_invitations', i.id)
      assertEq(invites.length, 1, 'the owner created a pending invitation')
      const invitationId = invites[0].id

      // ── The previously-dead step ──
      await send(newcomerPhone, 'accepter')

      const { data: sess } = await sb.from('signup_sessions')
        .select('user_type, step, data').eq('phone', newcomerPhone).maybeSingle()
      assert(!!sess, 'a signup session was written — this is the write that used to fail silently')
      assertEq((sess as { user_type?: string } | null)?.user_type, 'invite_accept',
        "user_type='invite_accept' — the value the CHECK constraint used to reject")
      assertEq((sess as { step?: number } | null)?.step, 1, 'at step 1, asking for a name')

      const carried = (sess as { data?: { invitation_ids?: string[] } } | null)?.data?.invitation_ids
      assert(Array.isArray(carried), 'the session carries invitation_ids')
      assertEq(carried?.length, 1, 'exactly one invitation id')
      assertEq(carried?.[0], invitationId, 'and it is THIS invitation — the ids survive the round trip')

      // ── Complete the signup: name, then city ──
      await send(newcomerPhone, 'Nouvelle Recrue')
      const { data: step2 } = await sb.from('signup_sessions')
        .select('step, data').eq('phone', newcomerPhone).maybeSingle()
      assertEq((step2 as { step?: number } | null)?.step, 2, 'the name advances it to step 2')
      assertEq((step2 as { data?: { name?: string } } | null)?.data?.name, 'Nouvelle Recrue',
        'with the name stashed')
      assertEq((step2 as { data?: { invitation_ids?: string[] } } | null)?.data?.invitation_ids?.[0],
        invitationId, 'and the invitation id still carried across the step')

      await send(newcomerPhone, '1')   // Yaoundé

      // The customer is created by the app, so the ledger has not seen it.
      const { data: created } = await sb.from('customers')
        .select('id, name, city').eq('phone', newcomerPhone).maybeSingle()
      assert(!!created, 'the invitee is now a registered customer')
      const newcomerId = (created as { id: string } | null)?.id ?? ''
      if (newcomerId) track('customers', newcomerId)
      assertEq((created as { name?: string } | null)?.name, 'Nouvelle Recrue', 'with the name they gave')

      // …and the invitation actually converted into team membership.
      const { data: teamData } = await sb.from('restaurant_team')
        .select('id, role, status').eq('restaurant_id', rest.id).eq('customer_id', newcomerId).maybeSingle()
      const row = teamData as { id: string; role: string; status: string } | null
      assert(!!row, 'a restaurant_team row was created — the invitation converted')
      if (row) track('restaurant_team', row.id)
      assertEq(row?.role, 'manager', 'with the invited role')
      assertEq(row?.status, 'active', 'and active')

      assertEq((await readInvites())[0]?.status, 'accepted', "the invitation is marked 'accepted'")
      assertEq(await sessionsFor(newcomerPhone), 0, 'and the signup session was consumed')
    })

    await step('#49 accepter with no pending invitation does nothing', async () => {
      const c = await makeCustomer({ suiteNo: 49, name: 'No Invite' })
      const r = await send(c.phone, 'accepter')
      assertEq(r.status, 200, 'still answered')
      const { data } = await sb.from('restaurant_team').select('id').eq('customer_id', c.id)
      assertEq((data ?? []).length, 0, 'and joined no team')
    })

    // ── The last-owner guard, through WhatsApp doors 5 and 6 ───────────────
    // Re-proves 0f356f4 from the WhatsApp side. The webhook answers 200
    // regardless, so the guard is visible only as the owner row surviving.

    await step('#49 last-owner guard: "retirer <self>" is refused (door 5)', async () => {
      const owner = await makeCustomer({ suiteNo: 49, name: 'Last Owner Retirer' })
      const rest  = await makeRestaurant({ ownerId: owner.id, label: 'wa_last_5', whatsapp: owner.phone })

      const before = await teamRowFor(rest.id, owner.id)
      assertEq(before?.role, 'owner', 'they start as the sole active owner')
      assertEq(before?.status, 'active', 'and active')

      await send(owner.phone, `retirer ${owner.phone}`)

      const after = await teamRowFor(rest.id, owner.id)
      assertEq(after?.role, 'owner', 'STILL role=owner after the removal attempt')
      assertEq(after?.status, 'active', 'and STILL active — the guard held')

      // The command itself works: adding someone else from the same phone
      // succeeds, so the refusal was the guard and not a throttle.
      const helper = await makeCustomer({ suiteNo: 49, name: 'Helper Five' })
      await send(owner.phone, `ajouter ${helper.phone} staff`)
      const helperRow = await teamRowFor(rest.id, helper.id)
      assert(!!helperRow, 'the same phone CAN still add a member — not throttled')
      if (helperRow) track('restaurant_team', helperRow.id)

      // With a second owner present, removal of one IS allowed — proving the
      // guard is about the LAST owner, not about owners in general.
      const coOwnerId = await addTeamMember(rest.id, helper.id, 'owner')
      assert(!!coOwnerId, 'the helper is promoted to a second owner')
      await send(owner.phone, `retirer ${helper.phone}`)
      assertEq((await teamRowFor(rest.id, helper.id))?.status, 'removed',
        'a co-owner CAN be removed once another owner exists')
      assertEq((await teamRowFor(rest.id, owner.id))?.status, 'active', 'and the original owner is untouched')
    })

    await step('#49 last-owner guard: "ajouter <self> staff" is refused (door 6)', async () => {
      const owner = await makeCustomer({ suiteNo: 49, name: 'Last Owner Ajouter' })
      const rest  = await makeRestaurant({ ownerId: owner.id, label: 'wa_last_6', whatsapp: owner.phone })

      const before = await teamRowFor(rest.id, owner.id)
      assertEq(before?.role, 'owner', 'sole active owner to start')

      // The upsert path: pointing "ajouter" at your own number with a lower
      // role would silently rewrite the owner row's role.
      await send(owner.phone, `ajouter ${owner.phone} staff`)

      const after = await teamRowFor(rest.id, owner.id)
      assertEq(after?.role, 'owner', 'STILL role=owner — the self-demote was refused')
      assertEq(after?.status, 'active', 'and still active')

      await send(owner.phone, `ajouter ${owner.phone} manager`)
      assertEq((await teamRowFor(rest.id, owner.id))?.role, 'owner',
        'refused for manager as well, not just staff')

      // Control: an ordinary add from the same phone still lands.
      const other = await makeCustomer({ suiteNo: 49, name: 'Helper Six' })
      await send(owner.phone, `ajouter ${other.phone} manager`)
      const otherRow = await teamRowFor(rest.id, other.id)
      assert(!!otherRow, 'an ordinary add from the same phone still works — not throttled')
      if (otherRow) track('restaurant_team', otherRow.id)
      assertEq(otherRow?.role, 'manager', 'and lands with the right role')
    })

  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
