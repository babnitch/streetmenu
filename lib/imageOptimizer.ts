// Server-only image optimizer.
//
// Re-encodes user uploads to WebP, resizes them per usage, strips EXIF
// (size + privacy — GPS metadata is gone), and generates a tiny 10×10
// base64 placeholder for the blur-up effect.
//
// Bandwidth target: every encoded asset under ~150 KB. Real-world results
// vary by source (a 4 MB phone photo lands around 80–120 KB at 800×450
// quality=75).
//
// All compressImage callers should treat a thrown error as "fall back to
// the original buffer + extension" — `safeCompress()` does exactly that.

import sharp from 'sharp'

export type ImageKind =
  | 'menu_item'           // 400×400, square thumb
  | 'restaurant_hero'     // 800×400, 2:1
  | 'restaurant_logo'     // 200×200, square
  | 'event_cover'         // 800×450, 16:9
  | 'generic'             // 1000×1000 cap, otherwise unchanged

interface Dims { width: number; height: number; fit: 'cover' | 'inside' }

const DIMS: Record<ImageKind, Dims> = {
  menu_item:       { width: 400,  height: 400, fit: 'cover'  },
  restaurant_hero: { width: 800,  height: 400, fit: 'cover'  },
  restaurant_logo: { width: 200,  height: 200, fit: 'cover'  },
  event_cover:     { width: 800,  height: 450, fit: 'cover'  },
  generic:         { width: 1000, height: 1000, fit: 'inside' },
}

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

// Failure-tolerant variant. When sharp can't read the input (e.g. an
// HEIC the build target doesn't ship a decoder for, or a corrupt file),
// returns the original buffer + extension so the upload still succeeds
// — only the compression bonus is lost.
export async function safeCompress(
  input: Buffer,
  kind: ImageKind,
  fallbackContentType: string,
): Promise<OptimizedImage> {
  try {
    return await compressImage(input, kind)
  } catch (e) {
    console.warn('[imageOptimizer] sharp failed, storing original:', (e as Error).message)
    const ext = fallbackContentType.split('/')[1]?.split(';')[0] ?? 'jpg'
    return {
      buffer:      input,
      contentType: fallbackContentType,
      extension:   ext,
      blurHash:    '',
      bytes:       input.length,
    }
  }
}
