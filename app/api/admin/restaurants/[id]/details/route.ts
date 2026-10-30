import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sanitizeText } from '@/lib/sanitize'
import { LINK_FIELDS, validateLinks } from '@/lib/restaurantLinks'

export const dynamic = 'force-dynamic'

// /api/admin/restaurants/[id]/details (I2) — Admin card → "Liens & notes":
// the public links, plus the ADMIN-ONLY phone_to_verify and note
// (restaurant_admin_notes: never public, never used for orders or
// WhatsApp). GET / PUT. Admin / super_admin; audited.
function authorize(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && ['super_admin', 'admin'].includes(s.role) ? s : null
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!authorize(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const [{ data: r }, { data: n }] = await Promise.all([
    supabaseAdmin.from('restaurants').select(`id, ${LINK_FIELDS.join(', ')}`).eq('id', params.id).maybeSingle(),
    supabaseAdmin.from('restaurant_admin_notes').select('phone_to_verify, note').eq('restaurant_id', params.id).maybeSingle(),
  ])
  if (!r) return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
  return NextResponse.json({ ...(r as unknown as Record<string, unknown>), phone_to_verify: n?.phone_to_verify ?? null, note: n?.note ?? null }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const s = authorize(req)
  if (!s) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const v = validateLinks(Object.fromEntries(LINK_FIELDS.map(f => [f, body[f] ?? ''])))
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  const { error } = await supabaseAdmin.from('restaurants').update(v.links).eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const phone = sanitizeText(body.phone_to_verify, 60) || null
  const note = sanitizeText(body.note, 1000) || null
  await supabaseAdmin.from('restaurant_admin_notes').upsert({ restaurant_id: params.id, phone_to_verify: phone, note, updated_at: new Date().toISOString() }, { onConflict: 'restaurant_id' })
  await writeAudit({
    action: 'restaurant_details_updated', targetType: 'restaurant', targetId: params.id,
    performedBy: s.id, performedByType: s.role, metadata: { links: v.links, has_phone_to_verify: !!phone },
  })
  return NextResponse.json({ ok: true })
}
