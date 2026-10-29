// N4b — menu files from WhatsApp.
//
// An owner / manager sends a photo or a PDF with the caption "menu": it is
// saved as a menu file (same rules as the web: 5 files, one PDF), one reply.
// "ajouter carte" explains how; a PDF without the caption gets a hint;
// staff are refused. The bot fetches media with our Twilio credentials from
// Twilio only — any other address is refused (the test server may also read
// our own Storage, which is how this suite sends media).
//
// Every phone is +999. Storage objects are removed at the end.

import { sb, RUN_ID } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api } from '../testkit/session'
import { makeCustomer, makeRestaurant, addTeamMember } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-menu-files-n4b'
const BUCKET = 'menu-files'
const SRC = `__test_src_${RUN_ID}`

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

async function lastTo(phone: string): Promise<string> {
  const { data } = await sb.from('message_log').select('body, created_at').like('to_number', `%${phone.replace('+', '')}%`)
    .order('created_at', { ascending: false }).limit(1)
  return String(data?.[0]?.body ?? '')
}
async function fileCount(rid: string): Promise<number> {
  const { count } = await sb.from('restaurant_menu_files').select('id', { count: 'exact', head: true }).eq('restaurant_id', rid)
  return count ?? 0
}

async function main(): Promise<void> {
  let rid = ''
  try {
    // Source media, in our Storage (public URLs).
    await sb.storage.from(BUCKET).upload(`${SRC}/p.png`, PNG, { contentType: 'image/png', upsert: true })
    await sb.storage.from(BUCKET).upload(`${SRC}/m.pdf`, PDF, { contentType: 'application/pdf', upsert: true })
    const url = (p: string) => sb.storage.from(BUCKET).getPublicUrl(`${SRC}/${p}`).data.publicUrl

    const owner = await makeCustomer({ suiteNo: 83, name: 'N4b Owner' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'n4b_r', whatsapp: owner.phone })
    rid = rest.id
    const media = (from: string, body: string, mediaUrl: string, type: string) =>
      api('/api/whatsapp/incoming', { form: { From: `whatsapp:${from}`, Body: body, NumMedia: '1', MediaUrl0: mediaUrl, MediaContentType0: type } })

    await step('"ajouter carte" explains how', async () => {
      await api('/api/whatsapp/incoming', { form: { From: `whatsapp:${owner.phone}`, Body: 'ajouter carte' } })
      assert(/légende \*menu\*|caption \*menu\*/.test(await lastTo(owner.phone)), 'instructions sent')
    })

    await step('photo + "menu" → saved as a menu file, one reply', async () => {
      await media(owner.phone, 'menu', url('p.png'), 'image/png')
      assertEq(await fileCount(rid), 1, 'one file')
      const { data } = await sb.from('restaurant_menu_files').select('kind, path').eq('restaurant_id', rid).single()
      assertEq(data!.kind, 'photo', 'photo')
      assert((data!.path as string).startsWith(`${rid}/`), 'in the restaurant\'s folder')
      assert(/Carte ajoutée \(1\/5\)|Menu added \(1\/5\)/.test(await lastTo(owner.phone)), 'reply "Carte ajoutée (1/5)"')
    })

    await step('a PDF without the caption → hint, nothing saved', async () => {
      await media(owner.phone, '', url('m.pdf'), 'application/pdf')
      assertEq(await fileCount(rid), 1, 'still one file')
      assert(/légende \*menu\*|caption \*menu\*/.test(await lastTo(owner.phone)), 'hint sent')
    })

    await step('PDF + "carte" → saved; a second PDF refused', async () => {
      await media(owner.phone, 'carte', url('m.pdf'), 'application/pdf')
      assertEq(await fileCount(rid), 2, 'two files')
      await media(owner.phone, 'menu', url('m.pdf'), 'application/pdf')
      assertEq(await fileCount(rid), 2, 'still two')
      assert(/Un seul PDF|Only one PDF/.test(await lastTo(owner.phone)), 'refusal reply')
    })

    await step('staff can\'t add menu files', async () => {
      const staff = await makeCustomer({ suiteNo: 83, name: 'N4b Staff' })
      await addTeamMember(rid, staff.id, 'staff')
      await media(staff.phone, 'menu', url('p.png'), 'image/png')
      assertEq(await fileCount(rid), 2, 'nothing added')
      assert(/permission/.test(await lastTo(staff.phone)), 'refused')
    })

    await step('media from any other address is not fetched', async () => {
      await media(owner.phone, 'menu', 'https://example.com/menu.png', 'image/png')
      assertEq(await fileCount(rid), 2, 'nothing added')
      assert(/illisible|Could not read/.test(await lastTo(owner.phone)), 'reply: could not read')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    for (const f of [rid, SRC].filter(Boolean)) {
      const { data } = await sb.storage.from(BUCKET).list(f, { limit: 100 })
      if (data?.length) await sb.storage.from(BUCKET).remove(data.map(o => `${f}/${o.name}`))
    }
    await teardown()
  }
  finish(SUITE)
}

void main()
