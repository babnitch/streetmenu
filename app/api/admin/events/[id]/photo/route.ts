import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { checkPhotoBody, blurFor } from '@/lib/adminPhotos'

export const dynamic = 'force-dynamic'

// POST /api/admin/events/[id]/photo  { cover_photo?, blur_hash?, photo_credit? }
// Replace (URL from /api/upload/image) or remove (null) the poster of an
// existing event — managed or an organiser's — and set the optional photo
// credit. One audit row (event_photo_changed) per field changed, with the old
// and new value. A rejected (= deleted) event can't be changed. Nobody is
// messaged. super_admin | admin.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const check = checkPhotoBody(body, ['cover_photo'])
  if (!check.ok) return NextResponse.json({ error: check.error, field: check.field }, { status: 400 })

  const { data: e } = await supabaseAdmin.from('events').select('id, title, cover_photo, photo_credit, event_status')
    .eq('id', params.id).maybeSingle()
  if (!e || e.event_status === 'rejected') return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })

  const before = e as Record<string, string | null>
  const changed = Object.keys(check.patch).filter(f => (before[f] ?? null) !== check.patch[f])
  if (!changed.length) return NextResponse.json({ ok: true, event: e, changed: [] })

  const update = { ...check.patch, ...blurFor(before.cover_photo ?? null, 'cover_photo' in check.patch ? check.patch.cover_photo : before.cover_photo ?? null, body.blur_hash) }
  const { data: saved, error } = await supabaseAdmin.from('events').update(update)
    .eq('id', e.id).neq('event_status', 'rejected').select('id, cover_photo, blur_hash, photo_credit').maybeSingle()
  if (error || !saved) {
    console.error('[admin/events/photo] update failed:', error?.message)
    return NextResponse.json({ error: 'Erreur serveur / Server error' }, { status: 500 })
  }
  for (const field of changed) {
    await writeAudit({
      action: 'event_photo_changed', targetType: 'event', targetId: e.id,
      performedBy: session.id, performedByType: session.role,
      previousData: { [field]: before[field] ?? null },
      metadata: { field, old: before[field] ?? null, new: check.patch[field], title: e.title },
    })
  }
  return NextResponse.json({ ok: true, event: saved, changed })
}
