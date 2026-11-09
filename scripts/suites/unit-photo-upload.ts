// Photo upload format rules, no database (lib/imageOptimizer.ts, lib/photoUpload.ts):
//   - the real format is read from the bytes (a HEIC labelled image/jpeg is
//     still HEIC)
//   - a photo sharp can't read is kept only if it really is JPEG / PNG / GIF
//     / WebP; anything else (HEIC…) → refused (null), never stored
//   - the shared limits and messages

import sharp from 'sharp'
import { sniffImageType, safeCompress, isImageKind } from '@/lib/imageOptimizer'
import { isStorableImageType, PHOTO_MAX_BYTES, PHOTO_TOO_BIG, PHOTO_BAD_FORMAT } from '@/lib/photoUpload'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-photo-upload'

/** The first bytes of an iPhone HEIC (ISO-BMFF « ftypheic »), then junk. */
const FAKE_HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1'), Buffer.alloc(200, 7)])

async function main(): Promise<void> {
  await step('format read from the bytes', async () => {
    const jpg = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#c33' } }).jpeg().toBuffer()
    const png = await sharp({ create: { width: 20, height: 10, channels: 4, background: '#c33' } }).png().toBuffer()
    const webp = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#c33' } }).webp().toBuffer()
    const gif = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#c33' } }).gif().toBuffer()
    assertEq([sniffImageType(jpg), sniffImageType(png), sniffImageType(webp), sniffImageType(gif)], ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], 'the four storable formats')
    assertEq(sniffImageType(FAKE_HEIC), null, 'HEIC → not storable')
    assertEq(sniffImageType(Buffer.from('hello')), null, 'text → not storable')
  })

  await step('never store what a browser can\'t show', async () => {
    assertEq(await safeCompress(FAKE_HEIC, 'restaurant_hero'), null, 'HEIC sharp can\'t read → refused')
    const brokenJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)])
    const kept = await safeCompress(brokenJpeg, 'restaurant_hero')
    assert(!!kept && ['image/jpeg', 'image/webp'].includes(kept.contentType), `a real JPEG sharp can't read is kept as JPEG (${kept?.contentType})`)
    const ok = await safeCompress(await sharp({ create: { width: 30, height: 20, channels: 3, background: '#3c3' } }).png().toBuffer(), 'restaurant_logo')
    assertEq(ok?.contentType, 'image/webp', 'a readable photo → WebP')
  })

  await step('limits and messages', () => {
    assertEq(PHOTO_MAX_BYTES, 4 * 1024 * 1024, '4 MB (under Vercel\'s 4.5 MB request cap)')
    assertEq(PHOTO_TOO_BIG.fr, 'Photo trop lourde (max 4 Mo)', 'too big, FR')
    assertEq(PHOTO_BAD_FORMAT.fr, 'Format non pris en charge, envoyez une photo JPEG ou PNG', 'bad format, FR')
    assertEq(['image/jpeg', 'image/png; x', 'IMAGE/WEBP', 'image/gif', 'image/heic', 'image/heif', '', 'application/pdf'].map(isStorableImageType), [true, true, true, true, false, false, false, false], 'storable types')
    assertEq([isImageKind('restaurant_hero'), isImageKind('toString'), isImageKind('nope')], [true, false, false], 'known kinds only')
  })

  finish(SUITE)
}

void main()
