import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { isRestaurantOwner } from '@/lib/vendorAccess'
import { checkPhotoBody, blurFor, focusResets, withoutFocus } from '@/lib/adminPhotos'
import { focusColumnsReady, selectWithFocus } from '@/lib/focusSelect'

export const dynamic = 'force-dynamic'

// POST { image_url?, logo_url?, blur_hash?, image_focus?, logo_focus? } — the
// OWNER replaces (URL from /api/upload/image) or removes (null) the
// restaurant's cover photo and/or logo, or sets its focus point ("x y" %;
// a new photo starts centred). Owner only: restaurants.customer_id or an active team owner.
// A new photo gets its own blur placeholder (never the old one's) and drops
// the admin photo credit, which was about the old photo. One audit row
// (restaurant_photo_changed) per field changed. The photo credit itself
// stays admin-only (/api/admin/restaurants/[id]/photo).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  if (!/^[0-9a-f-]{36}$/i.test(params.id) || !(await isRestaurantOwner(params.id, session.id))) {
    return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  delete body.photo_credit
  const check = checkPhotoBody(body, ['image_url', 'logo_url'])
  if (!check.ok) return NextResponse.json({ error: check.error, field: check.field }, { status: 400 })

  const { data: r } = await selectWithFocus('restaurants', 'id, name, image_url, logo_url',
    cols => supabaseAdmin.from('restaurants').select(cols).eq('id', params.id).is('deleted_at', null).maybeSingle())
  if (!r) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })

  const before = r as unknown as Record<string, string | null>
  const ready = await focusColumnsReady(supabaseAdmin as never)
  let patch = { ...check.patch, ...focusResets(check.patch, before) }
  if (!ready) {
    const stripped = withoutFocus(patch)
    if (!Object.keys(stripped).length) return NextResponse.json({ error: 'Cadrage indisponible pour l\'instant / Focus point not available yet', field: 'focus' }, { status: 503 })
    patch = stripped
  }
  const changed = Object.keys(patch).filter(f => (before[f] ?? null) !== patch[f])
  if (!changed.length) return NextResponse.json({ ok: true, image_url: before.image_url, logo_url: before.logo_url, image_focus: before.image_focus ?? null, logo_focus: before.logo_focus ?? null, changed: [] })

  const next = { ...before, ...patch }
  const photoChanged = changed.some(f => f === 'image_url' || f === 'logo_url')
  const update = {
    ...patch,
    ...blurFor(before.image_url || before.logo_url || null, next.image_url || next.logo_url || null, body.blur_hash),
    // The admin credit was about the old photo.
    ...(photoChanged ? { photo_credit: null } : {}),
  }
  const { data: saved, error } = await supabaseAdmin.from('restaurants').update(update)
    .eq('id', before.id as string).is('deleted_at', null).select(ready ? 'id, image_url, logo_url, blur_hash, image_focus, logo_focus' : 'id, image_url, logo_url, blur_hash').maybeSingle()
  if (error || !saved) return NextResponse.json({ error: 'Erreur serveur / Server error' }, { status: 500 })

  for (const field of changed) {
    await writeAudit({
      action: 'restaurant_photo_changed', targetType: 'restaurant', targetId: before.id as string,
      performedBy: session.id, performedByType: 'owner',
      previousData: { [field]: before[field] ?? null },
      metadata: { field, old: before[field] ?? null, new: patch[field], name: before.name },
    })
  }
  return NextResponse.json({ ok: true, ...(saved as unknown as Record<string, unknown>), changed })
}
