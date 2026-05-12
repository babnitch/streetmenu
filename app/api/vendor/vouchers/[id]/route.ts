import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// Vendor-scoped voucher PATCH/DELETE. Mirrors /api/admin/vouchers/[id] but
// rejects any voucher whose restaurant the caller doesn't own / manage.
// Platform-wide vouchers (restaurant_id IS NULL) are never editable here —
// only admins can touch those.

async function callerOwnsVoucher(customerId: string, voucherId: string): Promise<{ ok: true; restaurantId: string } | { ok: false }> {
  const { data: v } = await supabaseAdmin
    .from('vouchers').select('id, restaurant_id').eq('id', voucherId).maybeSingle()
  if (!v || !v.restaurant_id) return { ok: false }  // missing or platform-wide

  // Direct ownership
  const { data: direct } = await supabaseAdmin
    .from('restaurants').select('id').eq('id', v.restaurant_id).eq('customer_id', customerId).maybeSingle()
  if (direct) return { ok: true, restaurantId: v.restaurant_id }

  // Team owner/manager
  const { data: team } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', v.restaurant_id).eq('customer_id', customerId)
    .eq('status', 'active').in('role', ['owner', 'manager']).maybeSingle()
  if (team) return { ok: true, restaurantId: v.restaurant_id }

  return { ok: false }
}

// PATCH — toggle is_active. Voucher must belong to one of the caller's
// restaurants; staff can't toggle (handled implicitly by the role filter).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const guard = await callerOwnsVoucher(session.id, params.id)
  if (!guard.ok) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  if (typeof body.is_active !== 'boolean') {
    return NextResponse.json({ error: 'is_active boolean required' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('vouchers').update({ is_active: body.is_active }).eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          body.is_active ? 'voucher_reactivated' : 'voucher_deactivated',
    targetType:      'voucher',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: 'vendor',
    metadata:        { restaurant_id: guard.restaurantId },
  })
  return NextResponse.json({ ok: true })
}

// DELETE — only when the voucher has never been used. Same rule as the
// admin route; lets vendors clean up typos without losing audit history
// on real usage.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const guard = await callerOwnsVoucher(session.id, params.id)
  if (!guard.ok) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })

  const { data: v } = await supabaseAdmin
    .from('vouchers').select('current_uses, code').eq('id', params.id).maybeSingle()
  if ((v?.current_uses ?? 0) > 0) {
    return NextResponse.json({ error: 'Bon déjà utilisé / Voucher already used' }, { status: 409 })
  }

  const { error } = await supabaseAdmin.from('vouchers').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          'voucher_deleted',
    targetType:      'voucher',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: 'vendor',
    metadata:        { restaurant_id: guard.restaurantId, code: v?.code ?? null },
  })
  return NextResponse.json({ ok: true })
}
