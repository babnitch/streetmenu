import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { error: custError } = await supabaseAdmin
    .from('customers')
    .update({ status: 'active', suspended_at: null, suspended_by: null, suspension_reason: null })
    .eq('id', params.id)

  if (custError) {
    console.error('[reactivate account] error:', custError)
    return NextResponse.json({ error: custError.message }, { status: 500 })
  }

  // Reactivate only restaurants that were auto-suspended due to account deletion
  const { data: reactivated, error: restError } = await supabaseAdmin
    .from('restaurants')
    .update({ status: 'active', suspended_at: null, suspended_by: null, suspension_reason: null })
    .eq('customer_id', params.id)
    .eq('suspended_by', 'system')
    .select('id')

  if (restError) {
    console.error('[reactivate account] restaurants error:', restError)
  }

  return NextResponse.json({ ok: true, restaurantsReactivated: reactivated?.length ?? 0 })
}
