import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { deriveStatus } from '@/lib/vouchers'

export const dynamic = 'force-dynamic'

// Organizer voucher management for a single event. Only the event's organizer
// (or an admin) may list/create — scoped so the created voucher's event_id is
// pinned to this event (event-specific promo codes).

async function authorize(req: NextRequest, eventId: string) {
  const session = getSessionFromRequest(req)
  if (!session) return { error: NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 }) }
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)
  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id, title, city').eq('id', eventId).maybeSingle()
  if (!event) return { error: NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 }) }
  if (!isAdmin && event.organizer_id !== session.id) {
    return { error: NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 }) }
  }
  return { session, event }
}

// GET /api/events/[id]/vouchers — list this event's vouchers with derived status.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authorize(req, params.id)
  if ('error' in auth) return auth.error

  const { data } = await supabaseAdmin
    .from('vouchers')
    .select('id, code, discount_type, discount_value, min_order, max_uses, current_uses, per_customer_max, is_active, expires_at, event_id, created_at')
    .eq('event_id', params.id)
    .order('created_at', { ascending: false })

  const vouchers = (data ?? []).map(v => ({ ...v, status: deriveStatus(v) }))
  return NextResponse.json({ vouchers })
}

// POST /api/events/[id]/vouchers — create an event-scoped voucher.
// Body: { code?, discount_type: 'percent'|'fixed', discount_value, max_uses?,
//         per_customer_max?, expires_at?, is_active? }
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authorize(req, params.id)
  if ('error' in auth) return auth.error
  const { session, event } = auth

  const body = await req.json().catch(() => ({}))
  let code = (body.code ?? '').toString().trim().toUpperCase()
  if (!code) code = 'EVT-' + Math.random().toString(36).slice(2, 6).toUpperCase()

  const discountType = body.discount_type === 'fixed' ? 'fixed' : body.discount_type === 'percent' ? 'percent' : null
  const discountValue = Number(body.discount_value)
  if (!discountType || !Number.isFinite(discountValue) || discountValue <= 0) {
    return NextResponse.json({ error: 'Type et valeur requis / Type and value required' }, { status: 400 })
  }
  if (discountType === 'percent' && discountValue > 100) {
    return NextResponse.json({ error: 'Le pourcentage ne peut dépasser 100 / Percentage cannot exceed 100' }, { status: 400 })
  }

  const row: Record<string, unknown> = {
    code,
    discount_type:    discountType,
    discount_value:   Math.round(discountValue),
    min_order:        Number(body.min_order) || 0,
    max_uses:         body.max_uses != null && body.max_uses !== '' ? Math.max(0, parseInt(String(body.max_uses), 10)) : null,
    per_customer_max: body.per_customer_max != null && body.per_customer_max !== ''
      ? Math.max(0, parseInt(String(body.per_customer_max), 10)) : 1,
    expires_at:       body.expires_at || null,
    event_id:         event.id,      // pins the voucher to this event
    restaurant_id:    null,
    is_active:        body.is_active !== false,
  }

  const { data, error } = await supabaseAdmin.from('vouchers').insert(row).select('*').single()
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Ce code existe déjà / Code already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await writeAudit({
    action:          'voucher_created',
    targetType:      'voucher',
    targetId:        data.id,
    performedBy:     session.id,
    performedByType: session.role === 'customer' ? 'organizer' : session.role,
    metadata:        { code, event_id: event.id, event_title: event.title, discount_type: discountType, discount_value: discountValue },
  })

  return NextResponse.json({ ok: true, voucher: { ...data, status: deriveStatus(data) } })
}
