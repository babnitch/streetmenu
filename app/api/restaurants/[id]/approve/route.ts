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

  const { error } = await supabaseAdmin
    .from('restaurants')
    .update({ status: 'active', is_active: true })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action: 'restaurant_approved',
    targetType: 'restaurant',
    targetId: params.id,
    performedBy: session.id,
    performedByType: session.role,
  })

  return NextResponse.json({ ok: true })
}
