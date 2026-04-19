import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH { is_active } — admin toggles a voucher. Logs 'voucher_deactivated'
// only on the active → inactive transition per the audit spec.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { is_active } = await req.json()
  if (typeof is_active !== 'boolean') {
    return NextResponse.json({ error: 'is_active requis / is_active required' }, { status: 400 })
  }

  const { data: before } = await supabaseAdmin
    .from('vouchers').select('id, code, is_active, discount_type, discount_value')
    .eq('id', params.id).maybeSingle()

  if (!before) return NextResponse.json({ error: 'Bon introuvable / Voucher not found' }, { status: 404 })

  const { error } = await supabaseAdmin
    .from('vouchers').update({ is_active }).eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (before.is_active && !is_active) {
    await writeAudit({
      action: 'voucher_deactivated',
      targetType: 'voucher',
      targetId: params.id,
      performedBy: session.id,
      performedByType: session.role,
      previousData: {
        code: before.code,
        discount_type: before.discount_type,
        discount_value: before.discount_value,
        is_active: before.is_active,
      },
    })
  }

  return NextResponse.json({ ok: true })
}

// DELETE /api/admin/vouchers/[id]
// Only allowed when the voucher has never been used. Otherwise callers are
// expected to deactivate. Prevents orphaning orders.voucher_code references.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: before } = await supabaseAdmin
    .from('vouchers').select('id, code, current_uses').eq('id', params.id).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Bon introuvable / Voucher not found' }, { status: 404 })

  if ((before.current_uses ?? 0) > 0) {
    return NextResponse.json({
      error: 'Ce bon a déjà été utilisé — désactivez-le à la place / Voucher already used — deactivate instead',
    }, { status: 409 })
  }

  // Clean up any still-unused claims before removing the voucher itself.
  await supabaseAdmin.from('customer_vouchers').delete().eq('voucher_id', params.id).is('used_at', null)
  const { error } = await supabaseAdmin.from('vouchers').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action: 'voucher_deleted',
    targetType: 'voucher',
    targetId: params.id,
    performedBy: session.id,
    performedByType: session.role,
    previousData: { code: before.code },
  })

  return NextResponse.json({ ok: true })
}
