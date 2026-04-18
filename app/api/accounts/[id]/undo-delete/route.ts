import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const targetId = params.id

  // Customer can undo their own; admins can undo any
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

  await supabaseAdmin.from('customers').update({
    status: 'active',
    deleted_at: null,
  }).eq('id', targetId)

  return NextResponse.json({ ok: true })
}
