// N4a — the menu as photos or a PDF, and the WhatsApp / call tap counter.
//
// Owner / manager / admin get a one-time upload link (type, 5 MB, 5 files,
// one PDF checked first), upload straight to Storage, then the server checks
// the real file and records it. Public list; reorder; delete (Storage too).
// Taps on "Commander sur WhatsApp" / "Appeler" are counted (a customer's
// repeat within a minute counts once); the owner sees the 30-day totals.
// A managed restaurant taking orders sends WhatsApp to its order number.
//
// Every phone is +999. Storage objects are removed at the end.

import { sb, testPhone, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-menu-files-n4a'
const BUCKET = 'menu-files'

// 1×1 PNG and a minimal PDF.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

interface Body { ok?: boolean; error?: string; path?: string; token?: string; file?: { id: string; kind: string; url: string }; files?: Array<{ id: string; kind: string }>; order_whatsapp?: string | null; whatsapp?: number; call?: number; counted?: boolean }

async function main(): Promise<void> {
  const folders: string[] = []
  try {
    const owner = await makeCustomer({ suiteNo: 82, name: 'N4a Owner' })
    const oc = customerCookie(owner)
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'n4a_r' })
    folders.push(rest.id)
    const base = `/api/restaurants/${rest.id}/menu-files`

    const upload = async (buf: Buffer, contentType: string): Promise<{ status: number; body: Body }> => {
      const u = await api<Body>(`${base}/upload-url`, { cookie: oc, body: { contentType, bytes: buf.length } })
      if (u.status !== 200) return u
      const up = await sb.storage.from(BUCKET).uploadToSignedUrl(u.body.path!, u.body.token!, buf, { contentType })
      if (up.error) throw new Error(`storage upload: ${up.error.message}`)
      return api<Body>(base, { cookie: oc, body: { path: u.body.path } })
    }

    await step('upload link: type and size checked first; strangers refused', async () => {
      assertEq((await api<Body>(`${base}/upload-url`, { cookie: oc, body: { contentType: 'image/gif', bytes: 100 } })).status, 409, 'GIF → 409')
      assertEq((await api<Body>(`${base}/upload-url`, { cookie: oc, body: { contentType: 'image/jpeg', bytes: 6 * 1024 * 1024 } })).status, 409, '6 MB → 409')
      const stranger = await makeCustomer({ suiteNo: 82, name: 'N4a Stranger' })
      assertEq((await api<Body>(`${base}/upload-url`, { cookie: customerCookie(stranger), body: { contentType: 'image/png', bytes: 100 } })).status, 403, 'not on the team → 403')
      assertEq((await api<Body>(`${base}/upload-url`, { body: { contentType: 'image/png', bytes: 100 } })).status, 401, 'logged out → 401')
    })

    let photoId = ''
    await step('a photo: uploaded, checked, listed publicly', async () => {
      const r = await upload(PNG, 'image/png')
      assertEq(r.status, 200, `recorded (${JSON.stringify(r.body).slice(0, 80)})`)
      assertEq(r.body.file?.kind, 'photo', 'kind photo')
      photoId = r.body.file!.id
      const g = await api<Body>(base)
      assertEq(g.body.files?.length, 1, 'public list')
      assertEq(g.body.order_whatsapp, rest.whatsapp, 'WhatsApp = the restaurant\'s')
    })

    await step('a path outside the restaurant\'s folder is refused', async () => {
      const r = await api<Body>(base, { cookie: oc, body: { path: `00000000-0000-0000-0000-000000000000/x.png` } })
      assertEq(r.status, 400, '400')
    })

    await step('one PDF at most', async () => {
      const r = await upload(PDF, 'application/pdf')
      assertEq(r.status, 200, `PDF recorded (${JSON.stringify(r.body).slice(0, 80)})`)
      assertEq(r.body.file?.kind, 'pdf', 'kind pdf')
      const second = await api<Body>(`${base}/upload-url`, { cookie: oc, body: { contentType: 'application/pdf', bytes: PDF.length } })
      assertEq(second.status, 409, 'second PDF → 409')
      assert(/Un seul PDF/.test(second.body.error ?? '') && /Only one PDF/.test(second.body.error ?? ''), 'FR/EN')
    })

    await step('five files at most', async () => {
      for (let i = 0; i < 3; i++) assertEq((await upload(PNG, 'image/png')).status, 200, `photo ${i + 3}`)
      const sixth = await api<Body>(`${base}/upload-url`, { cookie: oc, body: { contentType: 'image/png', bytes: PNG.length } })
      assertEq(sixth.status, 409, '6th → 409')
    })

    await step('reorder, then delete (Storage object gone too)', async () => {
      const g = await api<Body>(base)
      const ids = g.body.files!.map(f => f.id)
      const rev = [...ids].reverse()
      assertEq((await api<Body>(base, { method: 'PATCH', cookie: oc, body: { order: rev } })).body.files?.map(f => f.id), rev, 'new order')
      assertEq((await api<Body>(base, { method: 'PATCH', cookie: oc, body: { order: ids.slice(1) } })).status, 400, 'incomplete order → 400')
      const { data: row } = await sb.from('restaurant_menu_files').select('path').eq('id', photoId).single()
      const d = await api<Body>(`${base}/${photoId}`, { method: 'DELETE', cookie: oc })
      assertEq(d.status, 200, 'deleted')
      assertEq(d.body.files?.length, 4, 'four left')
      const name = (row!.path as string).split('/')[1]
      const { data: left } = await sb.storage.from(BUCKET).list(rest.id, { search: name })
      assertEq((left ?? []).filter(o => o.name === name).length, 0, 'object removed')
    })

    await step('contact taps: counted; a customer\'s repeat within a minute counts once; owner sees totals', async () => {
      const click = (kind: string, cookie?: string) => api<Body>(`/api/restaurants/${rest.id}/contact-click`, { cookie, body: { kind } })
      assertEq((await click('sms')).status, 400, 'unknown kind → 400')
      assertEq((await click('whatsapp')).body.counted, true, 'anonymous counted')
      const buyer = await makeCustomer({ suiteNo: 82, name: 'N4a Buyer' })
      assertEq((await click('whatsapp', customerCookie(buyer))).body.counted, true, 'customer counted')
      assertEq((await click('whatsapp', customerCookie(buyer))).body.counted, false, 'repeat not counted')
      assertEq((await click('call', customerCookie(buyer))).body.counted, true, 'a call counts apart')
      const t = await api<Body>(`/api/restaurants/${rest.id}/contact-click`, { cookie: oc })
      assertEq([t.body.whatsapp, t.body.call], [2, 1], '30-day totals')
      assertEq((await api(`/api/restaurants/${rest.id}/contact-click`, { cookie: customerCookie(buyer) })).status, 403, 'customer can\'t read totals')
    })

    await step('managed restaurant taking orders: WhatsApp goes to its order number', async () => {
      const admin = await adminCookie()
      const { data: m } = await sb.from('restaurants').insert({
        name: `__t_n4a_managed_${Date.now()}`, city: testName('city'), lat: 0, lng: 0, whatsapp: testPhone(82, 9101),
        managed_by_platform: true, customer_id: null, is_active: true, status: 'active', modules: [],
      }).select('id').single()
      track('restaurants', m!.id as string)
      const orderNo = testPhone(82, 9102)
      await api(`/api/admin/restaurants/${m!.id}/contacts`, { cookie: admin, body: { action: 'add_order_phone', phone: orderNo } })
      assertEq((await api<Body>(`/api/restaurants/${m!.id}/menu-files`)).body.order_whatsapp, testPhone(82, 9101), 'Vitrine: its public WhatsApp')
      await api('/api/admin/modules', { method: 'PUT', cookie: admin, body: { subject: 'restaurant', id: m!.id, modules: ['orders'] } })
      assertEq((await api<Body>(`/api/restaurants/${m!.id}/menu-files`)).body.order_whatsapp, orderNo, 'taking orders: the order number')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    for (const f of folders) {
      const { data } = await sb.storage.from(BUCKET).list(f, { limit: 100 })
      if (data?.length) await sb.storage.from(BUCKET).remove(data.map(o => `${f}/${o.name}`))
    }
    await teardown()
  }
  finish(SUITE)
}

void main()
