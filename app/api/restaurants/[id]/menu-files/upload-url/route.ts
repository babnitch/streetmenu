import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { MENU_FILES_BUCKET, menuFileRefusal, menuFileType } from '@/lib/menuFiles'
import { listMenuFiles, menuFilePath } from '@/lib/menuFilesServer'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/menu-files/upload-url (N4a)
// { contentType, bytes } → { path, token }: a one-time upload straight to
// Storage (files up to 5 MB don't fit through a server function), after the
// same checks as the final POST. Owner / manager / admin.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const body = await req.json().catch(() => ({})) as { contentType?: unknown; bytes?: unknown }
  const contentType = String(body.contentType ?? '')
  const bytes = Number(body.bytes ?? 0)
  const refusal = menuFileRefusal(await listMenuFiles(params.id), contentType, bytes)
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 })
  const path = menuFilePath(params.id, menuFileType(contentType)!.ext)
  const { data, error } = await supabaseAdmin.storage.from(MENU_FILES_BUCKET).createSignedUploadUrl(path)
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'Erreur serveur / Server error' }, { status: 500 })
  return NextResponse.json({ path: data.path, token: data.token })
}
