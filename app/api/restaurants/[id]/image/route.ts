import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { isRestaurantOwner } from '@/lib/vendorAccess'
import { checkPhotoBody, blurFor } from '@/lib/adminPhotos'

export const dynamic = 'force-dynamic'

// POST { image_url?, logo_url?, blur_hash? } — the OWNER replaces (URL from
// /api/upload/image) or removes (null) the restaurant's cover photo and/or
// logo. Owner only: restaurants.customer_id or an active team owner.
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

  const { data: r } = await supabaseAdmin.from('restaurants').select('id, name, image_url, logo_url')
    .eq('id', params.id).is('deleted_at', null).maybeSingle()
  if (!r) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })

  const before = r as Record<string, string | null>
  const changed = Object.keys(check.patch).filter(f => (before[f] ?? null) !== check.patch[f])
  if (!changed.length) return NextResponse.json({ ok: true, image_url: before.image_url, logo_url: before.logo_url, changed: [] })

  const next = { ...before, ...check.patch }
  const update = {
    ...check.patch,
    ...blurFor(before.image_url || before.logo_url || null, next.image_url || next.logo_url || null, body.blur_hash),
    photo_credit: null,
  }
  const { data: saved, error } = await supabaseAdmin.from('restaurants').update(update)
    .eq('id', r.id).is('deleted_at', null).select('id, image_url, logo_url, blur_hash').maybeSingle()
  if (error || !saved) return NextResponse.json({ error: 'Erreur serveur / Server error' }, { status: 500 })

  for (const field of changed) {
    await writeAudit({
      action: 'restaurant_photo_changed', targetType: 'restaurant', targetId: r.id,
      performedBy: session.id, performedByType: 'owner',
      previousData: { [field]: before[field] ?? null },
      metadata: { field, old: before[field] ?? null, new: check.patch[field], name: r.name },
    })
  }
  return NextResponse.json({ ok: true, ...saved, changed })
}
