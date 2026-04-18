import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  // Count targets BEFORE updating the customer: the cascade trigger will
  // clear suspended_by='system' as soon as the customer row changes, so
  // counting after would always return 0 once the migration is installed.
  const { data: targets } = await supabaseAdmin
    .from('restaurants')
    .select('id')
    .eq('customer_id', params.id)
    .eq('suspended_by', 'system')

  const { error: custError } = await supabaseAdmin
    .from('customers')
    .update({ status: 'active', suspended_at: null, suspended_by: null, suspension_reason: null })
    .eq('id', params.id)

  if (custError) {
    console.error('[reactivate account] error:', custError)
    return NextResponse.json({ error: custError.message }, { status: 500 })
  }

  // Pre-migration fallback: if the cascade trigger isn't installed yet this
  // UPDATE does the work. Post-migration it's idempotent (trigger already ran).
  await supabaseAdmin
    .from('restaurants')
    .update({ status: 'active', suspended_at: null, suspended_by: null, suspension_reason: null })
    .eq('customer_id', params.id)
    .eq('suspended_by', 'system')

  await writeAudit({
    action: 'account_reactivated',
    targetType: 'customer',
    targetId: params.id,
    performedBy: session.id,
    performedByType: session.role,
    metadata: { restaurantsReactivated: targets?.length ?? 0 },
  })

  return NextResponse.json({ ok: true, restaurantsReactivated: targets?.length ?? 0 })
}
