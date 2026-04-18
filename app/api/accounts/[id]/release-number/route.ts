import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { releaseAccount } from '@/lib/releaseAccount'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'super_admin') {
    return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  }

  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, phone, deleted_at')
    .eq('id', params.id)
    .maybeSingle()

  if (!customer) {
    return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })
  }

  // Check account is already soft-deleted before releasing
  if (!customer.deleted_at) {
    return NextResponse.json({ error: 'Le compte doit d\'abord être supprimé / Account must be deleted first' }, { status: 400 })
  }

  // Check not already anonymized
  if ((customer.phone ?? '').startsWith('deleted_')) {
    return NextResponse.json({ error: 'Numéro déjà libéré / Number already released' }, { status: 400 })
  }

  await releaseAccount(params.id)

  return NextResponse.json({ ok: true, message: 'Numéro libéré et données anonymisées / Number released and data anonymized' })
}
