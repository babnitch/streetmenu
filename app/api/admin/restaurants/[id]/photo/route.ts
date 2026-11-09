import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { checkPhotoBody, blurFor } from '@/lib/adminPhotos'

export const dynamic = 'force-dynamic'

// POST /api/admin/restaurants/[id]/photo
//   { image_url?, logo_url?, blur_hash?, photo_credit? }
// Replace (URL from /api/upload/image) or remove (null) the cover / logo of
// an existing restaurant, and set the optional photo credit. One audit row
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

  const { data: r } = await supabaseAdmin.from('restaurants').select('id, name, image_url, logo_url, photo_credit')
    .eq('id', params.id).is('deleted_at', null).maybeSingle()
  if (!r) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })

  const before = r as Record<string, string | null>
  const changed = Object.keys(check.patch).filter(f => (before[f] ?? null) !== check.patch[f])
  if (!changed.length) return NextResponse.json({ ok: true, restaurant: r, changed: [] })

  const next = { ...before, ...check.patch }
  const update = { ...check.patch, ...blurFor(before.image_url || before.logo_url || null, next.image_url || next.logo_url || null, body.blur_hash) }
  const { data: saved, error } = await supabaseAdmin.from('restaurants').update(update)
    .eq('id', r.id).is('deleted_at', null).select('id, image_url, logo_url, blur_hash, photo_credit').maybeSingle()
  if (error || !saved) {
    console.error('[admin/restaurants/photo] update failed:', error?.message)
    return NextResponse.json({ error: 'Erreur serveur / Server error' }, { status: 500 })
  }
  for (const field of changed) {
    await writeAudit({
      action: 'restaurant_photo_changed', targetType: 'restaurant', targetId: r.id,
      performedBy: session.id, performedByType: session.role,
      previousData: { [field]: before[field] ?? null },
      metadata: { field, old: before[field] ?? null, new: check.patch[field], name: r.name },
    })
  }
  return NextResponse.json({ ok: true, restaurant: saved, changed })
}
