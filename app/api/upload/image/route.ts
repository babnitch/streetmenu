import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { safeCompress, isImageKind } from '@/lib/imageOptimizer'
import { PHOTO_MAX_BYTES, PHOTO_TOO_BIG, PHOTO_BAD_FORMAT } from '@/lib/photoUpload'

export const dynamic  = 'force-dynamic'
// Sharp is a native Node addon — keep this off the edge runtime.
export const runtime  = 'nodejs'
// Resize + WebP encode of a 5 MB phone photo takes ~500ms on cold and
// ~150ms on warm; default 10s function timeout is plenty.

// POST /api/upload/image
// multipart/form-data:
//   file: File              (required)
//   kind: ImageKind         (default 'generic')
//   bucket: 'photos' | 'restaurant-images' | 'menu-images' (default 'photos')
//   pathPrefix: string      (optional path scope, e.g. 'restaurants')
//
// Returns: { url, blur_hash, bytes, kind }
//
// Login required: without it anyone could fill our storage buckets. Every
// form that uploads (including "Ajouter un restaurant") is behind login.
export async function POST(req: NextRequest) {
  if (!getSessionFromRequest(req)) {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'multipart/form-data requis' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'file requis' }, { status: 400 })
  }
  // Vercel refuses bodies over 4.5 MB before this runs; the forms shrink
  // photos first (lib/uploadPhoto.ts), so this is the backstop.
  if (file.size > PHOTO_MAX_BYTES) {
    return NextResponse.json({ error: `${PHOTO_TOO_BIG.fr} / ${PHOTO_TOO_BIG.en}`, code: 'too_big' }, { status: 413 })
  }

  const rawKind = String(form.get('kind') ?? 'generic')
  const kind   = isImageKind(rawKind) ? rawKind : 'generic'
  const bucket = String(form.get('bucket') ?? 'photos')
  const prefix = String(form.get('pathPrefix') ?? '').replace(/^\/+|\/+$/g, '')

  const ALLOWED_BUCKETS = new Set(['photos', 'restaurant-images', 'menu-images'])
  if (!ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: 'bucket invalide' }, { status: 400 })
  }

  const badFormat = () => NextResponse.json({ error: `${PHOTO_BAD_FORMAT.fr} / ${PHOTO_BAD_FORMAT.en}`, code: 'format' }, { status: 415 })
  const rawType = (file.type || 'image/jpeg').toLowerCase()
  if (!rawType.startsWith('image/')) return badFormat()

  // Converted to WebP, or kept only if it really is JPEG / PNG / GIF / WebP:
  // never store an image a browser can't show (e.g. HEIC).
  const inputBuffer = Buffer.from(await file.arrayBuffer())
  const compressed = await safeCompress(inputBuffer, kind)
  if (!compressed) return badFormat()

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${compressed.extension}`
  const path = prefix ? `${prefix}/${filename}` : filename

  const { error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(path, compressed.buffer, {
      contentType: compressed.contentType,
      // 24h browser cache — assets are immutable (filename includes ts +
      // random suffix) so we could go longer, but 24h matches the spec
      // and keeps Vercel CDN behaviour predictable.
      cacheControl: '86400',
      upsert:       false,
    })
  if (error) {
    console.error('[upload/image] storage upload failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { data: pub } = supabaseAdmin.storage.from(bucket).getPublicUrl(path)
  return NextResponse.json({
    url:       pub.publicUrl,
    blur_hash: compressed.blurHash,
    bytes:     compressed.bytes,
    kind,
  })
}
