// M5 — "Demander l'activation" and Admin → Demandes.
//
// /api/pro/modules POST: customer only; restaurant owner only; unknown or
// already-on modules refused; one pending request per module (a second ask
// says alreadyPending). /api/admin/module-requests: admin only; accepting
// switches the module on (with what it needs) and tells the pro; declining
// leaves the modules alone. Admin phones are not +999: the dev server's send
// guard stops those messages before Twilio.
//
// Every test phone is +999.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-modules-m5'

interface Body { ok?: boolean; error?: string; alreadyPending?: boolean; modules?: string[] }
interface ReqRow { id: string; module: string; restaurant: { id: string } | null; organizer: { id: string } | null }

async function main(): Promise<void> {
  try {
    const owner = await makeCustomer({ suiteNo: 75, name: 'M5 Owner', extra: { organizer_modules: [] } })
    const stranger = await makeCustomer({ suiteNo: 75, name: 'M5 Stranger' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'm5_r', whatsapp: owner.phone, modules: [] })
    const oc = customerCookie(owner)
    const ask = (cookie: string | undefined, body: Record<string, unknown>) => api<Body>('/api/pro/modules', { cookie, body })
    const admin = await adminCookie()

    await step('asking: logged in, owner only, known and not already on', async () => {
      assertEq((await ask(undefined, { subject: 'restaurant', restaurant_id: rest.id, module: 'delivery' })).status, 401, 'logged out → 401')
      assertEq((await ask(oc, { subject: 'restaurant', restaurant_id: rest.id, module: 'nope' })).status, 400, 'unknown module → 400')
      assertEq((await ask(customerCookie(stranger), { subject: 'restaurant', restaurant_id: rest.id, module: 'delivery' })).status, 403, 'not the owner → 403')
      await sb.from('restaurants').update({ modules: ['orders'] }).eq('id', rest.id)
      assertEq((await ask(oc, { subject: 'restaurant', restaurant_id: rest.id, module: 'orders' })).status, 409, 'already on → 409')
    })

    await step('one pending request per module', async () => {
      const a = await ask(oc, { subject: 'restaurant', restaurant_id: rest.id, module: 'delivery' })
      assertEq(a.status, 200, `asked (${a.raw.slice(0, 100)})`)
      assertEq(a.body.alreadyPending, false, 'new request')
      const b = await ask(oc, { subject: 'restaurant', restaurant_id: rest.id, module: 'delivery' })
      assertEq(b.body.alreadyPending, true, 'second ask → already pending')
      const { count } = await sb.from('module_requests').select('id', { count: 'exact', head: true }).eq('restaurant_id', rest.id).eq('status', 'pending')
      assertEq(count, 1, 'one row')
      const mine = await api<{ pending?: Array<{ module: string }> }>('/api/pro/modules', { cookie: oc })
      assert((mine.body.pending ?? []).some(p => p.module === 'delivery'), 'the Pro page sees it as sent')
    })

    await step('admin: list, accept → module on and the pro is told', async () => {
      assertEq((await api('/api/admin/module-requests', { cookie: oc })).status, 401, 'a customer can\'t list')
      const list = await api<{ requests?: ReqRow[] }>('/api/admin/module-requests?subject=restaurant', { cookie: admin })
      const r = (list.body.requests ?? []).find(x => x.restaurant?.id === rest.id && x.module === 'delivery')
      assert(!!r, 'listed for admin')
      assertEq((await api(`/api/admin/module-requests/${r!.id}`, { cookie: oc, body: { decision: 'approve' } })).status, 401, 'a customer can\'t decide')
      const ok = await api<Body>(`/api/admin/module-requests/${r!.id}`, { cookie: admin, body: { decision: 'approve' } })
      assertEq(ok.status, 200, `accept → 200 (${ok.raw.slice(0, 100)})`)
      const { data } = await sb.from('restaurants').select('modules').eq('id', rest.id).single()
      assertEq((data as { modules: string[] }).modules, ['orders', 'delivery'], 'Livraison on')
      const { data: row } = await sb.from('module_requests').select('status').eq('id', r!.id).single()
      assertEq((row as { status: string }).status, 'approved', 'request approved')
      const { data: logs } = await sb.from('message_log').select('body').eq('related_id', r!.id).like('to_number', `%${owner.phone.replace('+', '')}%`)
      assert((logs ?? []).some(l => /Livraison|Delivery/.test(String(l.body))), 'the owner got the WhatsApp')
      const again = await api<Body>(`/api/admin/module-requests/${r!.id}`, { cookie: admin, body: { decision: 'approve' } })
      assertEq(again.status, 409, 'answering twice → 409')
    })

    await step('organiser request, declined → nothing changes', async () => {
      const a = await ask(oc, { subject: 'organizer', module: 'paid_tickets' })
      assertEq(a.status, 200, `asked (${a.raw.slice(0, 100)})`)
      const list = await api<{ requests?: ReqRow[] }>('/api/admin/module-requests?subject=organizer', { cookie: admin })
      const r = (list.body.requests ?? []).find(x => x.organizer?.id === owner.id)
      assert(!!r, 'listed')
      const no = await api<Body>(`/api/admin/module-requests/${r!.id}`, { cookie: admin, body: { decision: 'decline' } })
      assertEq(no.status, 200, 'decline → 200')
      const { data } = await sb.from('customers').select('organizer_modules').eq('id', owner.id).single()
      assertEq((data as { organizer_modules: string[] }).organizer_modules, [], 'modules unchanged')
    })

    await step('accepting Billets payants also turns on Réservations', async () => {
      await ask(oc, { subject: 'organizer', module: 'paid_tickets' })
      const list = await api<{ requests?: ReqRow[] }>('/api/admin/module-requests?subject=organizer', { cookie: admin })
      const r = (list.body.requests ?? []).find(x => x.organizer?.id === owner.id)!
      const ok = await api<Body>(`/api/admin/module-requests/${r.id}`, { cookie: admin, body: { decision: 'approve' } })
      assertEq(ok.body.modules, ['reservations', 'paid_tickets'], 'both on')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
