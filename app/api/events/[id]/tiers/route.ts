import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { getPublicTiersForEvent, getAllTiersForEvent } from '@/lib/tiers'

export const dynamic = 'force-dynamic'

// GET /api/events/[id]/tiers
// Public path returns only sellable tiers (active + within sales window).
// Organizer / admin sees every row (including inactive + expired) so the
// dashboard panel can show the full list.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ tiers: [] })

  const isOrganizer = session?.id === event.organizer_id
  const isAdmin = session ? ['super_admin', 'admin', 'moderator'].includes(session.role) : false
  const tiers = (isOrganizer || isAdmin)
    ? await getAllTiersForEvent(params.id)
    : await getPublicTiersForEvent(params.id)
  return NextResponse.json({ tiers })
}

// POST /api/events/[id]/tiers
// Body: { name, name_en?, price, max_quantity?, sort_order?, sales_start?, sales_end?, description? }
// Organizer-only (or admin). Creates an active tier.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (!isAdmin && event.organizer_id !== session.id) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const name = String(body?.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name requis' }, { status: 400 })

  const price = Number.isFinite(body?.price) ? Math.max(0, Math.round(body.price)) : 0
  const max_quantity = Number.isFinite(body?.max_quantity) ? Math.max(0, Math.round(body.max_quantity)) : 0
  const sort_order   = Number.isFinite(body?.sort_order)   ? Math.round(body.sort_order)   : 0

  const insertRow = {
    event_id:    event.id,
    name,
    name_en:     body?.name_en ? String(body.name_en).trim() : null,
    price,
    max_quantity,
    sort_order,
    sales_start: body?.sales_start ? String(body.sales_start) : null,
    sales_end:   body?.sales_end   ? String(body.sales_end)   : null,
    description: body?.description ? String(body.description).trim() : null,
    is_active:   true,
  }

  const { data, error } = await supabaseAdmin
    .from('event_ticket_tiers').insert(insertRow).select('*').single()
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'Erreur' }, { status: 500 })

  await writeAudit({
    action:          'tier_created',
    targetType:      'event',
    targetId:        event.id,
    performedBy:     session.id,
    performedByType: session.role,
    metadata:        { tier_id: data.id, name, price, max_quantity },
  })

  return NextResponse.json({ ok: true, tier: data })
}
