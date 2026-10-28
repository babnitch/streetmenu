import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/pro/modules — the signed-in pro's modules (M4/M5):
//   { organizer: string[],
//     restaurants: [{ id, name, modules }],          // restaurants they own
//     pending: [{ subject_type, restaurant_id, module }] }  // open requests
// Customer session only.
export async function GET(req: NextRequest) {
  const s = getSessionFromRequest(req)
  if (!s || s.role !== 'customer') return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const [{ data: me }, { data: rests }, { data: pending }] = await Promise.all([
    supabaseAdmin.from('customers').select('organizer_modules').eq('id', s.id).maybeSingle(),
    supabaseAdmin.from('restaurants').select('id, name, modules, status')
      .eq('customer_id', s.id).is('deleted_at', null).neq('status', 'deleted').order('name'),
    supabaseAdmin.from('module_requests').select('subject_type, restaurant_id, module')
      .eq('requested_by', s.id).eq('status', 'pending'),
  ])
  return NextResponse.json({
    organizer: (me?.organizer_modules as string[] | null) ?? [],
    restaurants: (rests ?? []).map(r => ({ id: r.id, name: r.name, status: r.status, modules: (r.modules as string[] | null) ?? [] })),
    pending: pending ?? [],
  }, { headers: { 'Cache-Control': 'no-store' } })
}
