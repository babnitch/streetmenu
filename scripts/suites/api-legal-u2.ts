// U2 — public pages and data deletion.
// The six pages answer without login. A deletion request comes from the
// web form or WhatsApp ("supprimer mes données"; a customer's plain
// "supprimer"); one open request per number. The admin anonymises: the
// account can't log in any more, name/phone/addresses/messages are gone,
// orders and bookings keep their amounts. Refused while the account owns a
// restaurant. Audited.
//
// Every phone is +999.

import { sb, testPhone } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-legal-u2'

async function main(): Promise<void> {
  const requestPhones: string[] = []
  try {
    await step('the six pages are public', async () => {
      for (const p of ['/a-propos', '/contact', '/conditions', '/confidentialite', '/remboursements', '/suppression-donnees']) {
        const r = await api(p)
        assertEq(r.status, 200, `${p} → 200 without login`)
      }
    })

    const admin = await adminCookie()
    const act = (body: Record<string, unknown>, cookie = admin) => api<{ ok?: boolean; error?: string; counts?: Record<string, number> }>('/api/admin/data-deletion', { cookie, body })
    const reqOf = async (phone: string) => (await sb.from('data_deletion_requests').select('id, status, via, customer_id, phone').eq('phone', phone)).data ?? []

    const cust = await makeCustomer({ suiteNo: 90, name: 'U2 Leaving Customer' })
    requestPhones.push(cust.phone)

    await step('web form: one open request per number, linked to the account', async () => {
      assertEq((await api('/api/data-deletion', { body: { phone: '123' } })).status, 400, 'bad number → 400')
      assertEq((await api('/api/data-deletion', { body: { phone: cust.phone, reason: 'test' } })).status, 200, 'request sent')
      assertEq((await api('/api/data-deletion', { body: { phone: cust.phone } })).status, 200, 'again → same answer')
      const rows = await reqOf(cust.phone)
      assertEq(rows.length, 1, 'one open request')
      assertEq([rows[0].via, rows[0].customer_id], ['web', cust.id], 'web, linked')
    })

    await step('WhatsApp: "supprimer mes données" and a customer\'s "supprimer"', async () => {
      const a = await makeCustomer({ suiteNo: 90, name: 'U2 WA One' }), b = await makeCustomer({ suiteNo: 90, name: 'U2 WA Two' })
      requestPhones.push(a.phone, b.phone)
      await api('/api/whatsapp/incoming', { form: { From: `whatsapp:${a.phone}`, Body: 'supprimer mes données' } })
      await api('/api/whatsapp/incoming', { form: { From: `whatsapp:${b.phone}`, Body: 'SUPPRIMER' } })
      assertEq((await reqOf(a.phone))[0]?.via, 'whatsapp', 'request from "supprimer mes données"')
      assertEq((await reqOf(b.phone))[0]?.via, 'whatsapp', 'request from "supprimer"')
      const { data } = await sb.from('message_log').select('body').like('to_number', `%${a.phone.replace('+', '')}%`)
      assert((data ?? []).some(m => /Demande de suppression reçue|Deletion request received/.test(String(m.body))), 'one reply')
    })

    await step('anonymise: no login, no name/phone/address/messages; amounts kept', async () => {
      const rest = await makeRestaurant({ label: 'u2_r' })
      const o = await makeOrder(rest.id, cust, { status: 'delivered', total: 3000, extra: { fulfilment: 'delivery', delivery_address: 'Rue privée 12', delivery_phone: cust.phone, delivery_landmark: 'Maison bleue' } })
      await sb.from('message_log').insert({ channel: 'whatsapp', to_number: `whatsapp:${cust.phone}`, from_number: 'test', body: 'hello', status: 'sent' })
      assertEq((await act({ action: 'anonymise', id: (await reqOf(cust.phone))[0].id }, customerCookie(cust))).status, 401, 'customer → 401')
      const r = await act({ action: 'anonymise', id: (await reqOf(cust.phone))[0].id })
      assertEq(r.status, 200, `anonymised (${r.raw.slice(0, 80)})`)
      const { data: c } = await sb.from('customers').select('name, phone, status').eq('id', cust.id).single()
      assertEq([c!.name, c!.status], ['Compte supprimé', 'deleted'], 'account deleted')
      assert(c!.phone === `deleted:${cust.id}`, 'phone replaced (can\'t log in)')
      const { data: od } = await sb.from('orders').select('customer_name, customer_phone, delivery_address, delivery_phone, delivery_landmark, total_price').eq('id', o.id).single()
      assertEq([od!.customer_name, od!.customer_phone, od!.delivery_address, od!.delivery_phone, od!.delivery_landmark], ['Client supprimé', '', '—', null, null], 'order without personal data')
      assertEq(Number(od!.total_price), 3000, 'amount kept')
      const { count } = await sb.from('message_log').select('id', { count: 'exact', head: true }).like('to_number', `%${cust.phone.replace('+', '')}%`)
      assertEq(count, 0, 'messages deleted')
      const { data: req } = await sb.from('data_deletion_requests').select('status, phone').eq('customer_id', cust.id).single()
      assert(req!.status === 'done' && req!.phone.includes('…'), 'request done, number masked')
      requestPhones.push(req!.phone)
      const { data: au } = await sb.from('audit_log').select('id').eq('action', 'customer_anonymised').eq('target_id', cust.id)
      assertEq(au?.length, 1, 'audited')
    })

    await step('refused while the account owns a restaurant; reject works', async () => {
      const owner = await makeCustomer({ suiteNo: 90, name: 'U2 Owner' })
      requestPhones.push(owner.phone)
      await makeRestaurant({ ownerId: owner.id, label: 'u2_owned' })
      await api('/api/data-deletion', { body: { phone: owner.phone } })
      const id = (await reqOf(owner.phone))[0].id
      const r = await act({ action: 'anonymise', id })
      assertEq(r.status, 409, 'owner → 409')
      assert(/possède un restaurant/.test(r.body.error ?? ''), 'reason')
      assertEq((await act({ action: 'reject', id, note: 'owner' })).status, 200, 'rejected')
      assertEq((await reqOf(owner.phone))[0].status, 'rejected', 'status rejected')
    })

    await step('admin adds a request by hand', async () => {
      const p = testPhone(90, 9101)
      requestPhones.push(p)
      assertEq((await act({ action: 'create', phone: p })).status, 200, 'created')
      assertEq((await reqOf(p)).length, 1, 'listed')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    if (requestPhones.length) await sb.from('data_deletion_requests').delete().in('phone', requestPhones)
    await sb.from('message_log').delete().eq('from_number', 'test').like('to_number', 'whatsapp:+999%')
    await teardown()
  }
  finish(SUITE)
}

void main()
