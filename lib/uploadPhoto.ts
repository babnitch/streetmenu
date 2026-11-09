'use client'

// Every photo form uploads through here: shrink in the browser (longest side
// 1600 px, JPEG, whole picture kept — lib/shrinkImage.ts), check format and
// size, then POST /api/upload/image. Errors come back as FR / EN text.

import { shrinkImage } from '@/lib/shrinkImage'
import { PHOTO_MAX_BYTES, PHOTO_TOO_BIG, PHOTO_BAD_FORMAT, PHOTO_UPLOAD_FAILED, isStorableImageType } from '@/lib/photoUpload'
import type { ImageKind } from '@/lib/imageOptimizer'

export type UploadPhotoResult =
  | { ok: true; url: string; blur_hash: string }
  | { ok: false; error: { fr: string; en: string } }

export async function uploadPhoto(raw: File, opts: { kind: ImageKind; pathPrefix?: string; bucket?: string }): Promise<UploadPhotoResult> {
  const file = await shrinkImage(raw)
  if (!isStorableImageType(file.type)) return { ok: false, error: PHOTO_BAD_FORMAT }
  if (file.size > PHOTO_MAX_BYTES) return { ok: false, error: PHOTO_TOO_BIG }
  const fd = new FormData()
  fd.append('file', file)
  fd.append('kind', opts.kind)
  if (opts.pathPrefix) fd.append('pathPrefix', opts.pathPrefix)
  if (opts.bucket) fd.append('bucket', opts.bucket)
  try {
    const r = await fetch('/api/upload/image', { method: 'POST', body: fd })
    if (r.status === 413) return { ok: false, error: PHOTO_TOO_BIG }
    if (r.status === 415) return { ok: false, error: PHOTO_BAD_FORMAT }
    const j = await r.json().catch(() => null)
    if (!r.ok || typeof j?.url !== 'string') return { ok: false, error: PHOTO_UPLOAD_FAILED }
    return { ok: true, url: j.url, blur_hash: typeof j.blur_hash === 'string' ? j.blur_hash : '' }
  } catch {
    return { ok: false, error: PHOTO_UPLOAD_FAILED }
  }
}
