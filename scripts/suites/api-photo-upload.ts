// POST /api/upload/image over HTTP:
//   - a HEIC (even labelled image/jpeg) → 415 « Format non pris en charge,
//     envoyez une photo JPEG ou PNG », nothing stored
//   - over 4 MB → 413 « Photo trop lourde (max 4 Mo) »
//   - a real photo → 200, stored as WebP, whole picture kept (2000×1000 cover
//     → 1600×800)
// The one file this stores is removed at the end.

import sharp from 'sharp'
import { sb, BASE } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { customerCookie } from '../testkit/session'
import { makeCustomer } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-photo-upload'
const PREFIX = '__t_upload'
const FAKE_HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1'), Buffer.alloc(200, 7)])

async function upload(cookie: string, bytes: Buffer, type: string, name: string, kind = 'restaurant_hero') {
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(bytes)], { type }), name)
  fd.append('kind', kind)
  fd.append('pathPrefix', PREFIX)
  const r = await fetch(`${BASE}/api/upload/image`, { method: 'POST', body: fd, headers: { Cookie: cookie } })
  return { status: r.status, body: await r.json().catch(() => ({})) as { url?: string; error?: string; code?: string } }
}

async function stored(): Promise<string[]> {
  const { data } = await sb.storage.from('photos').list(PREFIX, { limit: 100 })
  return (data ?? []).map(f => f.name)
}

async function main(): Promise<void> {
  const cleanup: string[] = []
  try {
    const user = await makeCustomer({ suiteNo: 97, name: 'Upload Tester' })
    const cookie = customerCookie(user)
    const before = (await stored()).length

    await step('HEIC refused with a clear message, nothing stored', async () => {
      for (const [type, name] of [['image/heic', 'IMG_1.HEIC'], ['image/jpeg', 'IMG_2.jpg']]) {
        const r = await upload(cookie, FAKE_HEIC, type, name)
        assertEq([r.status, r.body.code], [415, 'format'], `${type} label → 415`)
        assert(r.body.error?.startsWith('Format non pris en charge, envoyez une photo JPEG ou PNG') ?? false, `message (${r.body.error})`)
      }
      assertEq((await stored()).length, before, 'nothing stored')
    })

    await step('over 4 MB refused', async () => {
      const r = await upload(cookie, Buffer.alloc(4 * 1024 * 1024 + 1, 1), 'image/jpeg', 'big.jpg')
      assertEq([r.status, r.body.code], [413, 'too_big'], '413')
      assert(r.body.error?.startsWith('Photo trop lourde (max 4 Mo)') ?? false, `message (${r.body.error})`)
    })

    await step('a real photo: stored as WebP, whole picture kept', async () => {
      const jpg = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#36c' } }).jpeg().toBuffer()
      const r = await upload(cookie, jpg, 'image/jpeg', 'cover.jpg')
      assertEq(r.status, 200, '200')
      const url = r.body.url ?? ''
      cleanup.push(url.split('/photos/')[1] ?? '')
      const m = await sharp(Buffer.from(await (await fetch(url)).arrayBuffer())).metadata()
      assertEq(`${m.format} ${m.width}x${m.height}`, 'webp 1600x800', 'WebP, shrunk not cropped')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    // Test fixtures: hard-deleted on purpose.
    const paths = cleanup.filter(Boolean)
    if (paths.length) await sb.storage.from('photos').remove(paths)
    await teardown()
    finish(SUITE)
  }
}

void main()
