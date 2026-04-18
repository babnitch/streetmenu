import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: accounts } = await supabaseAdmin
    .from('customers')
    .select('id, name, phone, city, status, suspended_at, suspension_reason, deleted_at, created_at')
    .order('created_at', { ascending: false })
    .limit(200)

  return NextResponse.json({ accounts: accounts ?? [] })
}
