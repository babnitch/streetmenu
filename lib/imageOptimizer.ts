// Server-only image optimizer.
//
// Re-encodes user uploads to WebP, resizes them per usage, strips EXIF
// (size + privacy — GPS metadata is gone), and generates a tiny 10×10
// base64 placeholder for the blur-up effect.
//
// Bandwidth: pages never download these files as stored — next/image serves
// a resized copy (at most 1024 px wide, next.config.js) per the <Image sizes>.
// Restaurant covers and logos are kept whole (up to 1600 / 600 px) so the
// focus point can pick any part of them.
//
// All compressImage callers should treat a thrown error as "fall back to
// the original buffer + extension" — `safeCompress()` does exactly that.

import sharp from 'sharp'

export type ImageKind =
  | 'menu_item'           // 400×400, square thumb
  | 'restaurant_hero'     // up to 1600×1600 — whole photo kept, cropped on display
  | 'restaurant_logo'     // up to 600×600 — whole photo kept, cropped on display
  | 'event_cover'         // 800×450, 16:9 (legacy covers)
  | 'event_poster'        // up to 1080×1350, 4:5 portrait — nothing cropped
  | 'menu_page'           // 1600×1600 cap — a paper menu photo, kept readable (N4b)
  | 'generic'             // 1000×1000 cap, otherwise unchanged

interface Dims { width: number; height: number; fit: 'cover' | 'inside' }

const DIMS: Record<ImageKind, Dims> = {
  menu_item:       { width: 400,  height: 400, fit: 'cover'  },
  // Never cropped here: the card / page box crops at display time
  // (object-fit: cover + the focus point, lib/photoFocus.ts), so « 🎯 Cadrage »
  // can still move to any part of the photo.
  restaurant_hero: { width: 1600, height: 1600, fit: 'inside' },
  restaurant_logo: { width: 600,  height: 600, fit: 'inside' },
  event_cover:     { width: 800,  height: 450, fit: 'cover'  },
  event_poster:    { width: 1080, height: 1350, fit: 'inside' },
  menu_page:       { width: 1600, height: 1600, fit: 'inside' },
  generic:         { width: 1000, height: 1000, fit: 'inside' },
}

export const isImageKind = (k: string): k is ImageKind => Object.prototype.hasOwnProperty.call(DIMS, k)

const WEBP_QUALITY = 75

export interface OptimizedImage {
  buffer:      Buffer
  contentType: string         // always 'image/webp' on success
  extension:   string         // 'webp' on success, else the original
  blurHash:    string          // base64 data-URL of the 10×10 thumbnail
  bytes:       number
}

// Compress + re-encode + tiny placeholder. Throws on unrecognised input;
// callers should prefer `safeCompress()` which always resolves.
export async function compressImage(input: Buffer, kind: ImageKind): Promise<OptimizedImage> {
  const dims = DIMS[kind]

  // Rotate per EXIF orientation BEFORE stripping metadata, otherwise
  // portrait photos come out sideways.
  const pipeline = sharp(input, { failOn: 'none' })
    .rotate()
    .resize({ width: dims.width, height: dims.height, fit: dims.fit, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY, effort: 4 })

  const buffer = await pipeline.toBuffer()
  const blurHash = await generateBlurHash(input)

  return {
    buffer,
    contentType: 'image/webp',
    extension:   'webp',
    blurHash,
    bytes:       buffer.length,
  }
}

// Tiny 10×10 base64-encoded preview. ~250–400 bytes — small enough to
// inline as the Next.js <Image blurDataURL> prop without ballooning the
// page payload.
export async function generateBlurHash(input: Buffer): Promise<string> {
  try {
    const thumb = await sharp(input, { failOn: 'none' })
      .rotate()
      .resize(10, 10, { fit: 'cover' })
      .webp({ quality: 30 })
      .toBuffer()
    return `data:image/webp;base64,${thumb.toString('base64')}`
  } catch {
    return ''
  }
}

// What the bytes really are (a phone may label a HEIC "image/jpeg"), among
// the formats every browser can show; null for anything else.
export function sniffImageType(b: Buffer): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

// Failure-tolerant variant. When sharp can't read the input (a corrupt file,
// or a format it has no decoder for) the original bytes are kept only if
// they really are JPEG / PNG / GIF / WebP — then only the compression bonus
// is lost. Anything else (HEIC, …) → null: the caller refuses it with
// PHOTO_BAD_FORMAT (lib/photoUpload.ts). Never store what a browser can't show.
export async function safeCompress(input: Buffer, kind: ImageKind): Promise<OptimizedImage | null> {
  try {
    return await compressImage(input, kind)
  } catch (e) {
    const type = sniffImageType(input)
    console.warn(`[imageOptimizer] sharp failed (${(e as Error).message}); ${type ? 'storing original' : 'refused: unsupported format'}`)
    if (!type) return null
    return {
      buffer:      input,
      contentType: type,
      extension:   type === 'image/jpeg' ? 'jpg' : type.split('/')[1],
      blurHash:    '',
      bytes:       input.length,
    }
  }
}
