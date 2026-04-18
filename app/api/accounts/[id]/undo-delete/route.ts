import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const targetId = params.id

  if (session.role === 'customer' && session.id !== targetId) {
    return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
  }
  if (session.role === 'moderator') {
    return NextResponse.json({ error: 'Permission insuffisante / Insufficient permission' }, { status: 403 })
  }

  const { data: customer } = await supabaseAdmin
    .from('customers').select('id, deleted_at')
    .eq('id', targetId).maybeSingle()

  if (!customer) return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })
  if (!customer.deleted_at) return NextResponse.json({ error: 'Pas supprimé / Not deleted' }, { status: 400 })

  const deletedAt = new Date(customer.deleted_at)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  if (deletedAt < thirtyDaysAgo && !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Délai de 30 jours dépassé / 30-day window has passed' }, { status: 400 })
  }

  // Count targets BEFORE updating the customer — the cascade trigger clears
  // suspended_by='system' on the customer status change, so post-update counts
  // would always be 0 once the migration is installed.
  const { data: targets } = await supabaseAdmin
    .from('restaurants')
    .select('id')
    .eq('customer_id', targetId)
    .eq('suspended_by', 'system')

  const { error: custError } = await supabaseAdmin
    .from('customers')
    .update({ status: 'active', deleted_at: null })
    .eq('id', targetId)

  if (custError) {
    return NextResponse.json({ error: custError.message }, { status: 500 })
  }

  // Pre-migration fallback: if the cascade trigger isn't installed yet, this
  // UPDATE does the reactivation. Post-migration it's idempotent.
  await supabaseAdmin
    .from('restaurants')
    .update({ status: 'active', suspended_at: null, suspended_by: null, suspension_reason: null })
    .eq('customer_id', targetId)
    .eq('suspended_by', 'system')

  return NextResponse.json({ ok: true, restaurantsReactivated: targets?.length ?? 0 })
}
