import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { reason } = await req.json()

  const { data: customer } = await supabaseAdmin
    .from('customers').select('id, status, deleted_at')
    .eq('id', params.id).maybeSingle()

  if (!customer) return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })
  if (customer.deleted_at) return NextResponse.json({ error: 'Compte supprimé / Account deleted' }, { status: 400 })

  await supabaseAdmin.from('customers').update({
    status: 'suspended',
    suspended_at: new Date().toISOString(),
    suspended_by: 'admin',
    suspension_reason: reason ?? null,
  }).eq('id', params.id)

  return NextResponse.json({ ok: true })
}
