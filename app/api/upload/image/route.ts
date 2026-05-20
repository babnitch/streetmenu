import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { safeCompress, type ImageKind } from '@/lib/imageOptimizer'

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
// Login-required by default — the only public-facing form that needs
// uploads is /join (vendor signup) and that route is invoked from a
// guest session, so the endpoint accepts anon callers too. Image hosts
// are public buckets anyway.
export async function POST(req: NextRequest) {
  void getSessionFromRequest(req)  // currently informational — every upload is open

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
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: 'Fichier trop volumineux (max 20 MB)' }, { status: 413 })
  }

  const kind   = String(form.get('kind') ?? 'generic') as ImageKind
  const bucket = String(form.get('bucket') ?? 'photos')
  const prefix = String(form.get('pathPrefix') ?? '').replace(/^\/+|\/+$/g, '')

  const ALLOWED_BUCKETS = new Set(['photos', 'restaurant-images', 'menu-images'])
  if (!ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: 'bucket invalide' }, { status: 400 })
  }

  const rawType = (file.type || 'image/jpeg').toLowerCase()
  if (!rawType.startsWith('image/')) {
    return NextResponse.json({ error: 'Type de fichier non supporté' }, { status: 415 })
  }

  const inputBuffer = Buffer.from(await file.arrayBuffer())
  const compressed = await safeCompress(inputBuffer, kind, rawType)

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
