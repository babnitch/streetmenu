import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { writeAudit } from '@/lib/audit'
import { removeMenuFile, listMenuFiles } from '@/lib/menuFilesServer'

export const dynamic = 'force-dynamic'

// DELETE /api/restaurants/[id]/menu-files/[fileId] (N4a) — remove a menu
// file (row + Storage object). Owner / manager / admin.
export async function DELETE(req: NextRequest, { params }: { params: { id: string; fileId: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const session = getSessionFromRequest(req)!
  if (!(await removeMenuFile(params.id, params.fileId))) {
    return NextResponse.json({ error: 'Fichier introuvable / File not found' }, { status: 404 })
  }
  await writeAudit({
    action: 'menu_file_removed', targetType: 'restaurant', targetId: params.id,
    performedBy: session.id, performedByType: session.role, metadata: { file_id: params.fileId },
  })
  return NextResponse.json({ ok: true, files: await listMenuFiles(params.id) })
}
