import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  await supabaseAdmin.from('customers').update({
    status: 'active',
    suspended_at: null,
    suspended_by: null,
    suspension_reason: null,
  }).eq('id', params.id)

  return NextResponse.json({ ok: true })
}
