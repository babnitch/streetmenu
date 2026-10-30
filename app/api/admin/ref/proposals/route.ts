import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { describe, type ProposalRow } from '@/lib/refProposals'

export const dynamic = 'force-dynamic'

// GET /api/admin/ref/proposals — pending proposals first, then the last 50
// resolved ones; with who proposed and on which item. Admin + super admin.
export async function GET(req: NextRequest) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const [pending, done] = await Promise.all([
    supabaseAdmin.from('ref_proposals').select('*').eq('status', 'pending').order('created_at', { ascending: false }).range(0, 199),
    supabaseAdmin.from('ref_proposals').select('*').neq('status', 'pending').order('resolved_at', { ascending: false }).limit(50),
  ])
  if (pending.error) return NextResponse.json({ error: pending.error.message }, { status: 500 })
  const rows = [...(pending.data ?? []), ...(done.data ?? [])] as ProposalRow[]
  return NextResponse.json({ proposals: await describe(rows) }, { headers: { 'Cache-Control': 'no-store' } })
}
