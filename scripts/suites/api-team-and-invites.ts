// TEST-PLAN.md §1c #33 — team roster, member management and invitations.
//
// The gate here is FOUR-way, and the asymmetry is the point:
//
//   GET  /team                     owner + manager (denyUnlessOwnerOrManager)
//   POST /team                     owner only
//   POST /invite, GET /invite      owner only
//   PATCH/DELETE /team/[memberId]  owner only
//   DELETE /invite/[invitationId]  owner only
//
// Viewing is deliberately one tier looser than managing: a manager needs to
// see the roster they work with, but adding and removing people is the
// owner's call. Manager-can-read-but-not-write is asserted in both
// directions, because a refactor that unified the two gates would be a
// regression whichever way it moved.
//
// LAST-OWNER PROTECTION is covered at the end of this file. A restaurant must
// always keep at least one ACTIVE owner: without that rule an owner could
// remove or demote their own team row, get a 200, and be permanently locked
// out, because every write route here authorizes solely via an active
// role='owner' team row, none admits the implicit owner from
// restaurants.customer_id, and they answer 401 to an admin session. SIX
// user-facing paths could each reach that state, so all six are asserted —
// plus two positive cases proving the guard blocks only the last owner and
// never an ordinary add.
//
// Also worth knowing while reading this file: the write routes return 401,
// not a bypass, for an ADMIN session (`session.role !== 'customer'`), unlike
// the menu routes where admins pass. Not asserted here and not changed.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, addTeamMember } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { testPhone } from '../testkit/env'

const SUITE = 'api-team-and-invites'

interface TeamMemberRow {
  id: string
  role: string
  status: string
  customers: { id: string; name: string; phone: string } | Array<{ id: string; name: string; phone: string }> | null
}
interface TeamBody { team?: TeamMemberRow[]; error?: string }
interface InviteBody {
  ok?: boolean
  mode?: 'added' | 'invited'
  member?: { id: string; name: string; phone: string }
  invitation?: { id: string; phone: string; role: string; expires_at: string }
  error?: string
}
interface InviteListBody { invitations?: Array<{ id: string; phone: string; role: string; status: string }> }

// The embed is a to-one relationship, but normalise defensively so the
// assertion tests the data rather than PostgREST's shape choice.
function memberOf(row: TeamMemberRow): { id: string; name: string; phone: string } | null {
  const c = row.customers
  if (!c) return null
  return Array.isArray(c) ? (c[0] ?? null) : c
}

async function main(): Promise<void> {
  try {
    // ── Fixtures ───────────────────────────────────────────────────────────
    const owner    = await makeCustomer({ suiteNo: 33, name: 'Team Owner' })
    const manager  = await makeCustomer({ suiteNo: 33, name: 'Team Manager' })
    const staff    = await makeCustomer({ suiteNo: 33, name: 'Team Staff' })
    const outsider = await makeCustomer({ suiteNo: 33, name: 'Team Outsider' })
    // Already an active customer → the instant "added" invite path.
    const known    = await makeCustomer({ suiteNo: 33, name: 'Known Invitee' })
    // Never created → the two-step "invited" path.
    const unknownPhone = testPhone(33, 9001)

    const restA = await makeRestaurant({ ownerId: owner.id, label: 'team_a', whatsapp: owner.phone })
    await addTeamMember(restA.id, manager.id, 'manager')
    await addTeamMember(restA.id, staff.id,   'staff')

    const ownerB = await makeCustomer({ suiteNo: 33, name: 'Other Owner' })
    const restB  = await makeRestaurant({ ownerId: ownerB.id, label: 'team_b', whatsapp: ownerB.phone })

    const cookies = {
      owner:    customerCookie(owner),
      manager:  customerCookie(manager),
      staff:    customerCookie(staff),
      outsider: customerCookie(outsider),
    }

    const getTeam = (id: string, cookie: string | null) =>
      api<TeamBody>(`/api/restaurants/${id}/team`, { ...(cookie ? { cookie } : {}) })
    const postTeam = (id: string, body: Record<string, unknown>, cookie: string | null) =>
      api<InviteBody>(`/api/restaurants/${id}/team`, { method: 'POST', body, ...(cookie ? { cookie } : {}) })
    const postInvite = (id: string, body: Record<string, unknown>, cookie: string | null) =>
      api<InviteBody>(`/api/restaurants/${id}/invite`, { method: 'POST', body, ...(cookie ? { cookie } : {}) })
    const listInvites = (id: string, cookie: string | null) =>
      api<InviteListBody>(`/api/restaurants/${id}/invite`, { ...(cookie ? { cookie } : {}) })
    const cancelInvite = (id: string, invId: string, cookie: string | null) =>
      api<InviteBody>(`/api/restaurants/${id}/invite/${invId}`, { method: 'DELETE', ...(cookie ? { cookie } : {}) })
    const patchMember = (id: string, memberId: string, body: Record<string, unknown>, cookie: string | null) =>
      api<InviteBody>(`/api/restaurants/${id}/team/${memberId}`, { method: 'PATCH', body, ...(cookie ? { cookie } : {}) })
    const deleteMember = (id: string, memberId: string, cookie: string | null) =>
      api<InviteBody>(`/api/restaurants/${id}/team/${memberId}`, { method: 'DELETE', ...(cookie ? { cookie } : {}) })

    const teamRow = async (restaurantId: string, customerId: string) => {
      const { data } = await sb.from('restaurant_team')
        .select('id, role, status').eq('restaurant_id', restaurantId).eq('customer_id', customerId).maybeSingle()
      return data as { id: string; role: string; status: string } | null
    }
    const pendingInvites = async (restaurantId: string, phone?: string) => {
      let q = sb.from('team_invitations').select('id, phone, role, status').eq('restaurant_id', restaurantId)
      if (phone) q = q.eq('phone', phone)
      const { data } = await q
      return (data ?? []) as Array<{ id: string; phone: string; role: string; status: string }>
    }

    // ══ 1. THE FOUR-WAY GATE ═══════════════════════════════════════════════

    await step('roster GET: owner and manager can read', async () => {
      const o = await getTeam(restA.id, cookies.owner)
      assertEq(o.status, 200, 'owner → 200')
      assert((o.body.team ?? []).length >= 3, 'owner sees the roster')

      const m = await getTeam(restA.id, cookies.manager)
      assertEq(m.status, 200, 'manager → 200 (viewing is one tier looser than managing)')
      assertEq((m.body.team ?? []).length, (o.body.team ?? []).length, 'manager sees the same roster as the owner')
    })

    await step('roster GET: staff, outsider and anonymous are refused', async () => {
      assertEq((await getTeam(restA.id, cookies.staff)).status, 403, 'staff → 403')
      assertEq((await getTeam(restA.id, cookies.outsider)).status, 403, 'outsider → 403')
      assertEq((await getTeam(restA.id, null)).status, 401, 'no session → 401, not 403')
    })

    await step('every WRITE route is owner-only — manager can read but not write', async () => {
      const memberRow = await teamRow(restA.id, staff.id)
      assert(!!memberRow, 'the staff member row exists to aim at')
      const memberId = memberRow!.id

      // Manager: reads fine (asserted above), writes refused everywhere.
      assertEq((await postTeam(restA.id, { phone: known.phone, role: 'staff' }, cookies.manager)).status, 403,
        'manager → POST /team → 403')
      assertEq((await postInvite(restA.id, { phone: known.phone, role: 'staff' }, cookies.manager)).status, 403,
        'manager → POST /invite → 403')
      assertEq((await listInvites(restA.id, cookies.manager)).status, 403,
        'manager → GET /invite → 403 (the invitation list is owner-only too)')
      assertEq((await patchMember(restA.id, memberId, { role: 'manager' }, cookies.manager)).status, 403,
        'manager → PATCH role → 403')
      assertEq((await deleteMember(restA.id, memberId, cookies.manager)).status, 403,
        'manager → DELETE member → 403')

      const after = await teamRow(restA.id, staff.id)
      assertEq(after?.role, 'staff', 'the staff row still has its original role')
      assertEq(after?.status, 'active', 'and is still active — no refused write leaked through')
    })

    await step('staff, outsider and anonymous are refused on the write routes', async () => {
      const memberId = (await teamRow(restA.id, staff.id))!.id
      for (const [label, cookie, expected] of [
        ['staff', cookies.staff, 403],
        ['outsider', cookies.outsider, 403],
        ['anonymous', null, 401],
      ] as const) {
        assertEq((await postInvite(restA.id, { phone: known.phone, role: 'staff' }, cookie)).status, expected,
          `${label} → POST /invite → ${expected}`)
        assertEq((await patchMember(restA.id, memberId, { role: 'manager' }, cookie)).status, expected,
          `${label} → PATCH role → ${expected}`)
        assertEq((await deleteMember(restA.id, memberId, cookie)).status, expected,
          `${label} → DELETE member → ${expected}`)
      }
      const after = await teamRow(restA.id, staff.id)
      assertEq(after?.status, 'active', 'the target member survived every refusal')
      assertEq(after?.role, 'staff', 'with its role intact')
    })

    // ══ 2. INVITE — KNOWN CUSTOMER (instant path) ══════════════════════════

    await step('inviting an existing active customer adds them immediately', async () => {
      const invitesBefore = await pendingInvites(restA.id, known.phone)

      const r = await postInvite(restA.id, { phone: known.phone, role: 'staff' }, cookies.owner)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.mode, 'added', "mode='added' — the instant path, not an invitation")
      assertEq(r.body.member?.id, known.id, 'the response names the customer that was added')

      const row = await teamRow(restA.id, known.id)
      assert(!!row, 'a restaurant_team row was created')
      if (row) track('restaurant_team', row.id)
      assertEq(row?.role, 'staff', 'with the requested role')
      assertEq(row?.status, 'active', 'and active straight away')

      const invitesAfter = await pendingInvites(restA.id, known.phone)
      assertEq(invitesAfter.length, invitesBefore.length,
        'and NO team_invitations row was created for the instant path')
    })

    await step('the added member appears on the roster', async () => {
      const r = await getTeam(restA.id, cookies.owner)
      const ids = (r.body.team ?? []).map(m => memberOf(m)?.id)
      assert(ids.includes(known.id), 'the newly added member is on the roster')
    })

    // ══ 3. INVITE — UNKNOWN NUMBER (two-step path) ═════════════════════════

    let pendingInvitationId = ''
    await step('inviting a number with no account creates a pending invitation', async () => {
      const r = await postInvite(restA.id, { phone: unknownPhone, role: 'manager' }, cookies.owner)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.mode, 'invited', "mode='invited' — the two-step path")
      pendingInvitationId = r.body.invitation?.id ?? ''
      assert(!!pendingInvitationId, 'an invitation id came back')
      // Track it so the ledger removes the row AND its audit_log entry, which
      // is keyed on the invitation id.
      if (pendingInvitationId) track('team_invitations', pendingInvitationId)

      const rows = await pendingInvites(restA.id, unknownPhone)
      assertEq(rows.length, 1, 'exactly one team_invitations row')
      assertEq(rows[0]?.status, 'pending', "status='pending'")
      assertEq(rows[0]?.role, 'manager', 'carrying the requested role')

      // No customer exists for that phone, so no team row can have been made.
      const { count } = await sb.from('restaurant_team')
        .select('*', { count: 'exact' }).eq('restaurant_id', restA.id).limit(0)
      const { data: cust } = await sb.from('customers').select('id').eq('phone', unknownPhone).maybeSingle()
      assertEq(cust, null, 'no customer was created for the invited number')
      assert((count ?? 0) > 0, 'the roster is unchanged in shape (sanity)')
    })

    await step('the owner can list and cancel a pending invitation', async () => {
      const list = await listInvites(restA.id, cookies.owner)
      assertEq(list.status, 200, 'owner → GET /invite → 200')
      const ids = (list.body.invitations ?? []).map(i => i.id)
      assert(ids.includes(pendingInvitationId), 'the pending invitation is listed')

      const cancelled = await cancelInvite(restA.id, pendingInvitationId, cookies.owner)
      assertEq(cancelled.status, 200, 'cancel → 200')
      const rows = await pendingInvites(restA.id, unknownPhone)
      assertEq(rows[0]?.status, 'cancelled', "status flipped to 'cancelled'")

      // Documented as idempotent so the UI can just refresh.
      const again = await cancelInvite(restA.id, pendingInvitationId, cookies.owner)
      assertEq(again.status, 200, 'cancelling twice is a 200, not an error')
      assertEq((again.body as { noop?: boolean }).noop, true, 'and reports noop=true')

      const afterList = await listInvites(restA.id, cookies.owner)
      assert(!(afterList.body.invitations ?? []).map(i => i.id).includes(pendingInvitationId),
        'a cancelled invitation drops out of the pending list')
    })

    // ══ 6. DUPLICATE INVITE — two different behaviours ═════════════════════

    await step('a second invite to an unknown number with a live pending row is refused', async () => {
      const phone = testPhone(33, 9002)
      const first = await postInvite(restA.id, { phone, role: 'staff' }, cookies.owner)
      assertEq(first.status, 200, 'the first invite lands')
      const invId = first.body.invitation?.id ?? ''
      if (invId) track('team_invitations', invId)

      const second = await postInvite(restA.id, { phone, role: 'staff' }, cookies.owner)
      assertEq(second.status, 409, 'the second → 409 (owners cannot spam the same invitee)')

      const rows = await pendingInvites(restA.id, phone)
      assertEq(rows.filter(r => r.status === 'pending').length, 1,
        'still exactly one pending row — the duplicate created nothing')
    })

    await step('a second invite to a KNOWN customer just upserts — no 409', async () => {
      // Different path, different behaviour, and the asymmetry is easy to get
      // wrong: the known-customer branch never touches team_invitations, so
      // the pending-row guard never applies to it.
      const r = await postInvite(restA.id, { phone: known.phone, role: 'manager' }, cookies.owner)
      assertEq(r.status, 200, 'HTTP 200, not 409')
      assertEq(r.body.mode, 'added', "still mode='added'")

      const row = await teamRow(restA.id, known.id)
      assertEq(row?.role, 'manager', 'the upsert changed the role rather than duplicating the row')

      const { data } = await sb.from('restaurant_team')
        .select('id').eq('restaurant_id', restA.id).eq('customer_id', known.id)
      assertEq((data ?? []).length, 1, 'exactly one team row for that customer')
    })

    // ══ 4. ROLE ASSIGNMENT ═════════════════════════════════════════════════

    await step('POST /team adds a known customer with the requested role', async () => {
      const target = await makeCustomer({ suiteNo: 33, name: 'Direct Add' })
      const r = await postTeam(restA.id, { phone: target.phone, role: 'manager' }, cookies.owner)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)

      const row = await teamRow(restA.id, target.id)
      assert(!!row, 'the team row exists')
      if (row) track('restaurant_team', row.id)
      assertEq(row?.role, 'manager', "role='manager' as requested")

      // The route only adds registered numbers.
      const missing = await postTeam(restA.id, { phone: testPhone(33, 9003), role: 'staff' }, cookies.owner)
      assertEq(missing.status, 404, 'an unregistered number → 404 on POST /team')

      assertEq((await postTeam(restA.id, { phone: target.phone, role: 'owner' }, cookies.owner)).status, 400,
        "role='owner' is not assignable through this route → 400")
      assertEq((await postTeam(restA.id, { role: 'staff' }, cookies.owner)).status, 400, 'missing phone → 400')
    })

    await step('the owner can change a member’s role', async () => {
      const memberId = (await teamRow(restA.id, staff.id))!.id
      const r = await patchMember(restA.id, memberId, { role: 'manager' }, cookies.owner)
      assertEq(r.status, 200, 'HTTP 200')
      assertEq((await teamRow(restA.id, staff.id))?.role, 'manager', 'role changed')

      assertEq((await patchMember(restA.id, memberId, { role: 'chef' }, cookies.owner)).status, 400,
        'an invalid role → 400')
      assertEq((await teamRow(restA.id, staff.id))?.role, 'manager', 'and nothing changed')

      // Put it back so the removal step below reads naturally.
      await patchMember(restA.id, memberId, { role: 'staff' }, cookies.owner)
    })

    // ══ 5. REMOVE A MEMBER (owner self-removal deliberately excluded) ══════

    await step('the owner can remove a non-owner member', async () => {
      const victim = await makeCustomer({ suiteNo: 33, name: 'To Be Removed' })
      const rowId = await addTeamMember(restA.id, victim.id, 'staff')

      const before = await getTeam(restA.id, cookies.owner)
      assert((before.body.team ?? []).some(m => memberOf(m)?.id === victim.id), 'they start on the roster')

      const r = await deleteMember(restA.id, rowId, cookies.owner)
      assertEq(r.status, 200, 'HTTP 200')

      const row = await teamRow(restA.id, victim.id)
      assertEq(row?.status, 'removed', "the row is soft-removed (status='removed'), not deleted")

      const after = await getTeam(restA.id, cookies.owner)
      assert(!(after.body.team ?? []).some(m => memberOf(m)?.id === victim.id),
        'and they no longer appear on the roster, which lists active members only')
    })

    // ══ 7. AMBIGUOUS-FK REGRESSION GUARD ═══════════════════════════════════

    await step('the roster embeds real member details (ambiguous-FK guard)', async () => {
      // restaurant_team has TWO foreign keys into customers — customer_id and
      // added_by — so a bare `customers(...)` embed is ambiguous. Unqualified
      // it failed with PGRST201, the route swallowed it, and the dashboard
      // showed an EMPTY team while still answering 200. The fix names the FK
      // (customers!restaurant_team_customer_id_fkey). A regression to the bare
      // embed brings the empty roster back, so asserting a non-empty roster
      // WITH populated names and phones is what catches it — a length check
      // alone would not, and neither would a 200.
      const r = await getTeam(restA.id, cookies.owner)
      assertEq(r.status, 200, 'HTTP 200')
      const rows = r.body.team ?? []
      assert(rows.length >= 2, `the roster has 2+ members (got ${rows.length})`)

      for (const row of rows) {
        const m = memberOf(row)
        assert(!!m, `member row ${row.id} carries an embedded customer, not null`)
        assert(!!m?.name && m.name.length > 0, `member ${m?.id ?? '?'} has a name`)
        assert(!!m?.phone && m.phone.startsWith('+'), `member ${m?.id ?? '?'} has a phone`)
      }

      // The owner is on the roster with the right identity — proof the embed
      // followed customer_id and not added_by.
      const ownerEntry = rows.find(row => memberOf(row)?.id === owner.id)
      assert(!!ownerEntry, 'the owner appears on their own roster')
      assertEq(memberOf(ownerEntry!)?.name, owner.name, 'with their real name')
      assertEq(memberOf(ownerEntry!)?.phone, owner.phone, 'and their real phone')
      assertEq(ownerEntry?.role, 'owner', "and role='owner'")

      const managerEntry = rows.find(row => memberOf(row)?.id === manager.id)
      assertEq(memberOf(managerEntry!)?.name, manager.name, 'a second member also resolves to the right customer')
    })

    // ══ CROSS-RESTAURANT ═══════════════════════════════════════════════════

    await step('A’s owner cannot read or write B’s team', async () => {
      assertEq((await getTeam(restB.id, cookies.owner)).status, 403, "GET B's roster → 403")
      assertEq((await postInvite(restB.id, { phone: known.phone, role: 'staff' }, cookies.owner)).status, 403,
        "POST B's invite → 403")
      assertEq((await postTeam(restB.id, { phone: known.phone, role: 'staff' }, cookies.owner)).status, 403,
        "POST B's team → 403")
      assertEq((await listInvites(restB.id, cookies.owner)).status, 403, "GET B's invitations → 403")

      const bOwnerRow = await teamRow(restB.id, ownerB.id)
      assertEq((await deleteMember(restB.id, bOwnerRow!.id, cookies.owner)).status, 403,
        "DELETE a member of B → 403")

      const { data } = await sb.from('restaurant_team').select('id').eq('restaurant_id', restB.id).eq('status', 'active')
      assertEq((data ?? []).length, 1, "B's team is untouched — still just its own owner")
    })

    await step('an invitation belonging to another restaurant is not cancellable', async () => {
      const phone = testPhone(33, 9004)
      const made = await postInvite(restB.id, { phone, role: 'staff' }, customerCookie(ownerB))
      assertEq(made.status, 200, "B's owner creates an invitation on B")
      const invId = made.body.invitation?.id ?? ''
      if (invId) track('team_invitations', invId)

      // A's owner cannot reach it, and neither can the id be laundered through
      // A's own restaurant path.
      assertEq((await cancelInvite(restB.id, invId, cookies.owner)).status, 403,
        "A's owner cancelling on B's path → 403 (gate)")
      assertEq((await cancelInvite(restA.id, invId, cookies.owner)).status, 404,
        "A's owner cancelling B's invitation via A's path → 404 (scoping)")

      const rows = await pendingInvites(restB.id, phone)
      assertEq(rows[0]?.status, 'pending', "B's invitation is still pending")
    })

    // ══ LAST-OWNER PROTECTION (all six doors) ══════════════════════════════

    await step('the last active owner cannot be removed or demoted — all six doors', async () => {
      const soleOwner = await makeCustomer({ suiteNo: 33, name: 'Sole Owner' })
      const solo = await makeRestaurant({ ownerId: soleOwner.id, label: 'sole_owner', whatsapp: soleOwner.phone })
      const soloCookie = customerCookie(soleOwner)

      const ownRow = await teamRow(solo.id, soleOwner.id)
      assert(!!ownRow, 'the sole owner has an active owner row to defend')
      const rowId = ownRow!.id

      const stillOwner = async (label: string) => {
        const r = await teamRow(solo.id, soleOwner.id)
        assertEq(r?.role, 'owner', `${label}: still role='owner'`)
        assertEq(r?.status, 'active', `${label}: still status='active'`)
      }

      // 1. DELETE /team/[memberId] — self-removal
      assertEq((await deleteMember(solo.id, rowId, soloCookie)).status, 409, 'door 1 DELETE /team/[id] → 409')
      await stillOwner('door 1')

      // 2. PATCH /team/[memberId] — self-demote
      assertEq((await patchMember(solo.id, rowId, { role: 'staff' }, soloCookie)).status, 409,
        'door 2 PATCH role=staff → 409')
      await stillOwner('door 2')

      // 3. POST /team — the upsert rewrites the role of the existing row
      assertEq((await postTeam(solo.id, { phone: soleOwner.phone, role: 'staff' }, soloCookie)).status, 409,
        'door 3 POST /team own phone → 409')
      await stillOwner('door 3')

      // 4. POST /invite, known-customer branch — same upsert
      assertEq((await postInvite(solo.id, { phone: soleOwner.phone, role: 'manager' }, soloCookie)).status, 409,
        'door 4 POST /invite own phone → 409')
      await stillOwner('door 4')

      // 5. WhatsApp "retirer <self>" — the webhook always answers 200, so the
      //    refusal shows up as the row surviving, not as a status code.
      const wa5 = await api('/api/whatsapp/incoming', {
        form: { From: `whatsapp:${soleOwner.phone}`, Body: `retirer ${soleOwner.phone}` },
      })
      assertEq(wa5.status, 200, 'door 5 webhook accepted the message')
      await stillOwner('door 5 WhatsApp retirer')

      // 6. WhatsApp "ajouter <self> staff" — the upsert path
      const wa6 = await api('/api/whatsapp/incoming', {
        form: { From: `whatsapp:${soleOwner.phone}`, Body: `ajouter ${soleOwner.phone} staff` },
      })
      assertEq(wa6.status, 200, 'door 6 webhook accepted the message')
      await stillOwner('door 6 WhatsApp ajouter')

      // The refusal must be legible, not a silent no-op.
      const refused = await deleteMember(solo.id, rowId, soloCookie)
      assert((refused.body as { error?: string }).error?.includes('propriétaire'),
        'the refusal carries the bilingual last-owner message (FR)')
      assert((refused.body as { error?: string }).error?.toLowerCase().includes('at least one owner'),
        'and the EN half')
    })

    await step('the guard blocks the LAST owner only, not any owner', async () => {
      // Precision check: with two active owners, removing one is allowed.
      const o1 = await makeCustomer({ suiteNo: 33, name: 'Co-owner One' })
      const o2 = await makeCustomer({ suiteNo: 33, name: 'Co-owner Two' })
      const shared = await makeRestaurant({ ownerId: o1.id, label: 'co_owned', whatsapp: o1.phone })
      const secondRowId = await addTeamMember(shared.id, o2.id, 'owner')
      const c1 = customerCookie(o1)

      const { data: owners } = await sb.from('restaurant_team').select('id')
        .eq('restaurant_id', shared.id).eq('role', 'owner').eq('status', 'active')
      assertEq((owners ?? []).length, 2, 'the restaurant really has two active owners')

      assertEq((await deleteMember(shared.id, secondRowId, c1)).status, 200,
        'removing one of two owners → 200, not blocked')
      assertEq((await teamRow(shared.id, o2.id))?.status, 'removed', 'that owner row is removed')
      const remaining = await teamRow(shared.id, o1.id)
      assertEq(remaining?.role, 'owner', 'the other owner remains an owner')
      assertEq(remaining?.status, 'active', 'and is still active')

      // And now that they are the last one, they are protected.
      assertEq((await deleteMember(shared.id, remaining!.id, c1)).status, 409,
        'the survivor is now the last owner and is protected')
      assertEq((await teamRow(shared.id, o1.id))?.status, 'active', 'so they survive too')
    })

    await step('the guard never fires on an ordinary add or a non-owner target', async () => {
      const solo2 = await makeCustomer({ suiteNo: 33, name: 'Add Owner' })
      const rest2 = await makeRestaurant({ ownerId: solo2.id, label: 'adds_ok', whatsapp: solo2.phone })
      const cookie2 = customerCookie(solo2)
      const helper = await makeCustomer({ suiteNo: 33, name: 'Ordinary Member' })

      // Adding an ordinary member on a restaurant with exactly one owner must
      // not be mistaken for a demotion of that owner.
      const added = await postTeam(rest2.id, { phone: helper.phone, role: 'staff' }, cookie2)
      assertEq(added.status, 200, 'adding a staff member → 200')
      const hRow = await teamRow(rest2.id, helper.id)
      if (hRow) track('restaurant_team', hRow.id)
      assertEq(hRow?.role, 'staff', 'the member landed as staff')
      assertEq((await teamRow(rest2.id, solo2.id))?.role, 'owner', 'the owner is untouched')

      // Changing a NON-owner's role is unaffected by the guard.
      assertEq((await patchMember(rest2.id, hRow!.id, { role: 'manager' }, cookie2)).status, 200,
        "promoting a non-owner staff → manager → 200")
      assertEq((await teamRow(rest2.id, helper.id))?.role, 'manager', 'the promotion applied')

      // Removing a NON-owner is unaffected too — the no-regression case.
      assertEq((await deleteMember(rest2.id, hRow!.id, cookie2)).status, 200,
        'removing a non-owner member → 200')
      assertEq((await teamRow(rest2.id, helper.id))?.status, 'removed', 'that member is removed')
      assertEq((await teamRow(rest2.id, solo2.id))?.status, 'active', 'and the owner is still active')

      // An invite to a brand-new number is untouched by the guard as well.
      const invitePhone = testPhone(33, 9010)
      const inv = await postInvite(rest2.id, { phone: invitePhone, role: 'staff' }, cookie2)
      assertEq(inv.status, 200, 'inviting an unknown number still works')
      if (inv.body.invitation?.id) track('team_invitations', inv.body.invitation.id)
    })

    // ══ AUDIT ══════════════════════════════════════════════════════════════

    await step('the team actions write audit rows', async () => {
      const { data } = await sb.from('audit_log').select('action')
        .in('action', ['team_member_added', 'team_invitation_sent', 'team_invitation_cancelled',
                       'team_member_role_changed', 'team_member_removed'])
        .eq('metadata->>restaurant_id', restA.id)
      const actions = new Set((data ?? []).map(a => (a as { action: string }).action))
      for (const a of ['team_member_added', 'team_invitation_sent', 'team_invitation_cancelled',
                       'team_member_role_changed', 'team_member_removed']) {
        assert(actions.has(a), `${a} audit row written`)
      }
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
