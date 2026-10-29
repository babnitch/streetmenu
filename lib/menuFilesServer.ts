// Menu files on the server (N4a): list, add (after an upload straight to
// Storage), remove. Used by the API (web) and the bot (N4b). Server-only.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { MENU_FILES_BUCKET, menuFileRefusal, menuFileType, type MenuFile, type MenuFileKind } from '@/lib/menuFiles'

export async function listMenuFiles(restaurantId: string): Promise<MenuFile[]> {
  const { data } = await supabaseAdmin.from('restaurant_menu_files')
    .select('id, url, kind, position, bytes')
    .eq('restaurant_id', restaurantId)
    .order('position', { ascending: true }).order('created_at', { ascending: true })
  return (data ?? []) as MenuFile[]
}

export function menuFilePath(restaurantId: string, ext: string): string {
  return `${restaurantId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
}

export type AddResult = { ok: true; file: MenuFile } | { ok: false; status: number; error: string }

// Record a file already in Storage at `path` (checked: under the
// restaurant's folder, really there, its real type and size within limits).
// A refused file is removed from Storage.
export async function addMenuFile(restaurantId: string, path: string, addedBy: string | null): Promise<AddResult> {
  if (!path.startsWith(`${restaurantId}/`) || path.includes('..')) return { ok: false, status: 400, error: 'Chemin invalide / Invalid path' }
  const folder = restaurantId
  const name = path.slice(folder.length + 1)
  const { data: found } = await supabaseAdmin.storage.from(MENU_FILES_BUCKET).list(folder, { search: name, limit: 5 })
  const obj = (found ?? []).find(o => o.name === name)
  if (!obj) return { ok: false, status: 400, error: 'Fichier introuvable / File not found' }
  const meta = (obj.metadata ?? {}) as { size?: number; mimetype?: string }
  const bytes = Number(meta.size ?? 0)
  const contentType = String(meta.mimetype ?? '')

  const existing = await listMenuFiles(restaurantId)
  const refusal = menuFileRefusal(existing, contentType, bytes)
  if (refusal) {
    await supabaseAdmin.storage.from(MENU_FILES_BUCKET).remove([path])
    return { ok: false, status: 409, error: refusal }
  }
  const kind = menuFileType(contentType)!.kind as MenuFileKind
  const { data: pub } = supabaseAdmin.storage.from(MENU_FILES_BUCKET).getPublicUrl(path)
  const position = existing.reduce((m, f) => Math.max(m, f.position), -1) + 1
  const { data, error } = await supabaseAdmin.from('restaurant_menu_files')
    .insert({ restaurant_id: restaurantId, path, url: pub.publicUrl, kind, position, bytes, added_by: addedBy })
    .select('id, url, kind, position, bytes').single()
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? 'Erreur serveur / Server error' }
  return { ok: true, file: data as MenuFile }
}

export async function removeMenuFile(restaurantId: string, fileId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from('restaurant_menu_files')
    .delete().eq('id', fileId).eq('restaurant_id', restaurantId).select('path').maybeSingle()
  if (!data) return false
  await supabaseAdmin.storage.from(MENU_FILES_BUCKET).remove([data.path as string])
  return true
}
