// N3a — admin-managed restaurants ("managed by Tchop & Ndjoka").
//
// Created without an owner: listed at once, no team, nobody messaged, left
// out of "Non liés". Commandes is refused until there is an order contact
// (order number or team member); the order API refuses meanwhile. The
// restaurant's WhatsApp gets no owner commands and no orders. Contacts,
// change of owner (old owner removed or kept as manager, audited, no
// message), welcome only on request, remove owner → managed again.
//
// Every phone is +999.

import { sb, testName, testPhone } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, customerCookie } from '../testkit/session'
import { makeCustomer, makeMenuItem, testPictureUrl } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-managed-n3a'
const CITY = testName('city')

interface Body { ok?: boolean; error?: string; reason?: string; field?: string; restaurant?: Record<string, unknown> & { id: string }; order_phones?: string[]; orders_switched_off?: boolean; mode?: string; order?: { id: string } }

async function messagesTo(phone: string): Promise<number> {
  const { count } = await sb.from('message_log').select('id', { count: 'exact', head: true }).like('to_number', `%${phone.replace('+', '')}%`)
  return count ?? 0
}

async function main(): Promise<void> {
  try {
    const admin = await adminCookie()
    const publicWa = testPhone(80, 9101)
    let rid = ''

    await step('create without an owner → managed, listed, no team, no message', async () => {
      const r = await api<Body>('/api/admin/restaurants', {
        cookie: admin,
        body: { name: testName('n3a_managed'), city: CITY, lat: 3.87, lng: 11.52, logo_url: testPictureUrl(), whatsapp: publicWa, modules: ['orders', 'payment'] },
      })
      assertEq(r.status, 200, `created (${r.raw.slice(0, 100)})`)
      rid = r.body.restaurant!.id
      track('restaurants', rid)
      const { data } = await sb.from('restaurants').select('customer_id, managed_by_platform, status, is_active, modules, whatsapp').eq('id', rid).single()
      const row = data as { customer_id: string | null; managed_by_platform: boolean; status: string; is_active: boolean; modules: string[]; whatsapp: string }
      assertEq(row.customer_id, null, 'no owner')
      assertEq(row.managed_by_platform, true, 'managed')
      assertEq([row.status, row.is_active], ['active', true], 'published at once')
      assertEq(row.modules, [], 'Vitrine: Commandes (and Paiement) stripped')
      const { count } = await sb.from('restaurant_team').select('id', { count: 'exact', head: true }).eq('restaurant_id', rid)
      assertEq(count, 0, 'no team row')
      assertEq(await messagesTo(publicWa), 0, 'nobody messaged')
    })

    await step('publish: false → pending', async () => {
      const r = await api<Body>('/api/admin/restaurants', {
        cookie: admin,
        body: { name: testName('n3a_pending'), city: CITY, lat: 3.87, lng: 11.52, logo_url: testPictureUrl(), publish: false },
      })
      assertEq(r.status, 200, 'created')
      track('restaurants', r.body.restaurant!.id)
      assertEq([r.body.restaurant!.status, r.body.restaurant!.is_active], ['pending', false], 'pending, hidden')
    })

    await step('not in "Non liés" (orphaned list)', async () => {
      const r = await api<{ orphaned: Array<{ id: string }> }>('/api/admin/orphaned-restaurants', { cookie: admin })
      assertEq(r.status, 200, '200')
      assert(!r.body.orphaned.some(o => o.id === rid), 'managed restaurant not listed')
    })

    const buyer = await makeCustomer({ suiteNo: 80, name: 'N3a Buyer' })
    const dish = await makeMenuItem(rid, { price: 2000 })
    const order = () => api<Body>('/api/orders/create', {
      cookie: customerCookie(buyer),
      body: { restaurant_id: rid, order_type: 'reservation', items: [{ id: dish.id, quantity: 1 }], total_price: 2000 },
    })

    await step('Commandes refused without an order contact; orders refused', async () => {
      const m = await api<Body>('/api/admin/modules', { method: 'PUT', cookie: admin, body: { subject: 'restaurant', id: rid, modules: ['orders'] } })
      assertEq(m.status, 409, `switch on → 409 (${m.raw.slice(0, 80)})`)
      assert(/numéro de commande/.test(m.body.error ?? '') && /order number/.test(m.body.error ?? ''), 'FR/EN reason')
      // Even if the column said 'orders' (written directly), nothing passes.
      await sb.from('restaurants').update({ modules: ['orders'] }).eq('id', rid)
      const o = await order()
      assertEq(o.status, 403, `order API refuses (${o.raw.slice(0, 80)})`)
      const mods = await api<{ modules: string[] }>(`/api/admin/modules?subject=restaurant&id=${rid}`, { cookie: admin })
      assert(!(mods.body.modules ?? []).includes('orders'), 'gates read no Commandes')
      await sb.from('restaurants').update({ modules: [] }).eq('id', rid)
    })

    const orderNo = testPhone(80, 9102)
    await step('order number added → Commandes on → orders go to that number, not the public one', async () => {
      const bad = await api<Body>(`/api/admin/restaurants/${rid}/contacts`, { cookie: admin, body: { action: 'add_order_phone', phone: '123' } })
      assertEq(bad.status, 400, 'bad number → 400')
      const add = await api<Body>(`/api/admin/restaurants/${rid}/contacts`, { cookie: admin, body: { action: 'add_order_phone', phone: orderNo } })
      assertEq(add.status, 200, 'added')
      assertEq(add.body.order_phones, [orderNo], 'listed')
      const m = await api<Body>('/api/admin/modules', { method: 'PUT', cookie: admin, body: { subject: 'restaurant', id: rid, modules: ['orders'] } })
      assertEq(m.status, 200, `Commandes on (${m.raw.slice(0, 80)})`)
      const o = await order()
      assertEq(o.status, 200, `order accepted (${o.raw.slice(0, 80)})`)
      if (o.body.order) track('orders', o.body.order.id)
      const n = await api('/api/whatsapp/notify-order', { cookie: customerCookie(buyer), body: { orderId: o.body.order!.id } })
      assertEq(n.status, 200, 'notify 200')
      assert(await messagesTo(orderNo) >= 1, 'order number notified')
      assertEq(await messagesTo(publicWa), 0, 'public WhatsApp not notified')
    })

    await step('the last order contact stays while Commandes is on', async () => {
      const r = await api<Body>(`/api/admin/restaurants/${rid}/contacts`, { cookie: admin, body: { action: 'remove_order_phone', phone: orderNo } })
      assertEq(r.status, 409, 'refused')
      assertEq(r.body.reason, 'last_contact', 'reason')
    })

    await step('bot: the managed restaurant\'s number gets no owner commands', async () => {
      await api('/api/whatsapp/incoming', { form: { From: `whatsapp:${publicWa}`, Body: 'commandes' } })
      const { data } = await sb.from('message_log').select('body').like('to_number', `%${publicWa.replace('+', '')}%`)
      const bodies = (data ?? []).map(d => String(d.body)).join('\n')
      assert(!bodies.includes('Aucune commande') && !/commandes? (en attente|du jour)/i.test(bodies), 'no vendor order list')
      const { count } = await sb.from('customers').select('id', { count: 'exact', head: true }).eq('phone', publicWa)
      if ((count ?? 0) > 0) {
        const { data: c } = await sb.from('customers').select('id').eq('phone', publicWa)
        for (const x of c ?? []) track('customers', x.id as string)
      }
    })

    const first = await makeCustomer({ suiteNo: 80, name: 'N3a First Owner' })
    const second = await makeCustomer({ suiteNo: 80, name: 'N3a Second Owner' })
    await step('change owner: existing account, no message, managed off, audited', async () => {
      const r = await api<Body>(`/api/admin/restaurants/${rid}/owner`, { cookie: admin, body: { phone: first.phone } })
      assertEq(r.status, 200, `owner set (${r.raw.slice(0, 80)})`)
      const { data } = await sb.from('restaurants').select('customer_id, managed_by_platform').eq('id', rid).single()
      assertEq([data!.customer_id, data!.managed_by_platform], [first.id, false], 'owner + not managed')
      assertEq(await messagesTo(first.phone), 0, 'no message')
      const { data: a } = await sb.from('audit_log').select('id').eq('target_id', rid).eq('action', 'owner_changed')
      assert((a ?? []).length === 1, 'audited')
    })

    await step('change owner again: old owner choice is required, then kept as manager', async () => {
      const no = await api<Body>(`/api/admin/restaurants/${rid}/owner`, { cookie: admin, body: { phone: second.phone } })
      assertEq(no.status, 400, 'choice required')
      assertEq(no.body.field, 'old_owner', 'field')
      const r = await api<Body>(`/api/admin/restaurants/${rid}/owner`, { cookie: admin, body: { phone: second.phone, old_owner: 'manager' } })
      assertEq(r.status, 200, 'changed')
      const { data } = await sb.from('restaurant_team').select('customer_id, role, status').eq('restaurant_id', rid).eq('status', 'active')
      const roles = Object.fromEntries((data ?? []).map(t => [t.customer_id, t.role]))
      assertEq(roles[second.id], 'owner', 'new owner')
      assertEq(roles[first.id], 'manager', 'old owner kept as manager')
      const same = await api<Body>(`/api/admin/restaurants/${rid}/owner`, { cookie: admin, body: { phone: second.phone, old_owner: 'remove' } })
      assertEq(same.status, 409, 'already the owner → 409')
    })

    await step('welcome only on request: one message to the owner', async () => {
      assertEq(await messagesTo(second.phone), 0, 'nothing yet')
      const r = await api<Body>(`/api/admin/restaurants/${rid}/welcome`, { cookie: admin, body: {} })
      assertEq(r.status, 200, `sent (${r.raw.slice(0, 80)})`)
      assertEq(await messagesTo(second.phone), 1, 'one message')
    })

    await step('team: admin removes a manager; invites a new number (invitation pending)', async () => {
      const rm = await api<Body>(`/api/admin/restaurants/${rid}/contacts`, { cookie: admin, body: { action: 'remove_member', customer_id: first.id } })
      assertEq(rm.status, 200, 'manager removed')
      const fresh = testPhone(80, 9103)
      const inv = await api<Body>(`/api/admin/restaurants/${rid}/contacts`, { cookie: admin, body: { action: 'invite_member', phone: fresh, role: 'staff' } })
      assertEq(inv.status, 200, `invited (${inv.raw.slice(0, 80)})`)
      assertEq(inv.body.mode, 'invited', 'pending invitation')
      const { data } = await sb.from('team_invitations').select('id, invited_by').eq('restaurant_id', rid).eq('phone', fresh)
      for (const x of data ?? []) track('team_invitations', x.id as string)
      assertEq(data?.[0]?.invited_by ?? null, null, 'invited by the platform')
      const g = await api<{ invitations: Array<{ phone: string }>; owner: { phone: string } | null }>(`/api/admin/restaurants/${rid}/contacts`, { cookie: admin })
      assert(g.body.invitations.some(i => i.phone === fresh), 'listed as pending')
      assertEq(g.body.owner?.phone, second.phone, 'owner shown')
    })

    await step('remove owner → managed again; Commandes kept (an order number remains)', async () => {
      const r = await api<Body>(`/api/admin/restaurants/${rid}/owner`, { method: 'DELETE', cookie: admin, body: { old_owner: 'remove' } })
      assertEq(r.status, 200, 'removed')
      assertEq(r.body.orders_switched_off, false, 'still has an order number')
      const { data } = await sb.from('restaurants').select('customer_id, managed_by_platform, modules').eq('id', rid).single()
      assertEq([data!.customer_id, data!.managed_by_platform], [null, true], 'managed again')
      assert((data!.modules as string[]).includes('orders'), 'Commandes kept')
    })

    await step('admin-only', async () => {
      const r = await api(`/api/admin/restaurants/${rid}/contacts`, { cookie: customerCookie(buyer) })
      assertEq(r.status, 401, 'customer → 401')
      const o = await api(`/api/admin/restaurants/${rid}/owner`, { cookie: customerCookie(buyer), body: { phone: buyer.phone } })
      assertEq(o.status, 401, 'owner change → 401')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
