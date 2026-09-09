// TEST-PLAN.md §1d #45, #50, #51 — the customer, identity and session half of
// the WhatsApp router. (#46-#49, vendor management, land as a second commit.)
//
// Plus one #49 step that ships early, with the fix it proves: the
// invite_accept flow, which could never work until
// supabase-signup-session-types.sql widened signup_sessions.user_type.
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
import { makeCustomer, makeRestaurant, makeOrder, addTeamMember, type TestCustomer } from '../testkit/fixtures'
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

  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
