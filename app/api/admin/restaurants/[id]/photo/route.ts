import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { checkPhotoBody, blurFor, focusResets, withoutFocus } from '@/lib/adminPhotos'
import { focusColumnsReady, selectWithFocus } from '@/lib/focusSelect'

export const dynamic = 'force-dynamic'

const FOCUS_UNAVAILABLE = 'Cadrage indisponible pour l\'instant (base à mettre à jour) / Focus point not available yet (database update pending)'

// POST /api/admin/restaurants/[id]/photo
//   { image_url?, logo_url?, blur_hash?, photo_credit?, image_focus?, logo_focus? }
// Replace (URL from /api/upload/image) or remove (null) the cover / logo of
// an existing restaurant, its focus point ("x y" %, null = centre — a new
// photo starts centred) and the optional photo credit. One audit row
// (restaurant_photo_changed) per field changed, with the old and new value.
// A deleted restaurant can't be changed. The home rows and « À la une » read
// the photo live, so the change shows at once. super_admin | admin.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const check = checkPhotoBody(body, ['image_url', 'logo_url'])
  if (!check.ok) return NextResponse.json({ error: check.error, field: check.field }, { status: 400 })

  const { data: r } = await selectWithFocus('restaurants', 'id, name, image_url, logo_url, photo_credit',
    cols => supabaseAdmin.from('restaurants').select(cols).eq('id', params.id).is('deleted_at', null).maybeSingle())
  if (!r) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })

  const before = r as unknown as Record<string, string | null>
  const ready = await focusColumnsReady(supabaseAdmin as never)
  let patch = { ...check.patch, ...focusResets(check.patch, before) }
  if (!ready) {
    const stripped = withoutFocus(patch)
    if (!Object.keys(stripped).length) return NextResponse.json({ error: FOCUS_UNAVAILABLE, field: 'focus' }, { status: 503 })
    patch = stripped
  }
  const changed = Object.keys(patch).filter(f => (before[f] ?? null) !== patch[f])
  if (!changed.length) return NextResponse.json({ ok: true, restaurant: r, changed: [] })

  const next = { ...before, ...patch }
  const update = { ...patch, ...blurFor(before.image_url || before.logo_url || null, next.image_url || next.logo_url || null, body.blur_hash) }
  const { data: saved, error } = await supabaseAdmin.from('restaurants').update(update)
    .eq('id', before.id as string).is('deleted_at', null).select(ready ? 'id, image_url, logo_url, blur_hash, photo_credit, image_focus, logo_focus' : 'id, image_url, logo_url, blur_hash, photo_credit').maybeSingle()
  if (error || !saved) {
    console.error('[admin/restaurants/photo] update failed:', error?.message)
    return NextResponse.json({ error: 'Erreur serveur / Server error' }, { status: 500 })
  }
  for (const field of changed) {
    await writeAudit({
      action: 'restaurant_photo_changed', targetType: 'restaurant', targetId: before.id as string,
      performedBy: session.id, performedByType: session.role,
      previousData: { [field]: before[field] ?? null },
      metadata: { field, old: before[field] ?? null, new: patch[field], name: before.name },
    })
  }
  return NextResponse.json({ ok: true, restaurant: saved, changed })
}
