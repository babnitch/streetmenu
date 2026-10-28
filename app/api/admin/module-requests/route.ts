import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/admin/module-requests?subject=restaurant|organizer  (M5)
// Pending "Demander l'activation" requests, oldest first, with who asked and
// for what. super_admin / admin only.
export async function GET(req: NextRequest) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const subject = req.nextUrl.searchParams.get('subject')
  let q = supabaseAdmin.from('module_requests')
    .select(`id, subject_type, module, created_at, restaurant_id, customer_id,
      restaurant:restaurants!module_requests_restaurant_id_fkey(id, name, city, modules),
      organizer:customers!module_requests_customer_id_fkey(id, name, phone, organizer_modules),
      requester:customers!module_requests_requested_by_fkey(id, name, phone)`)
    .eq('status', 'pending').order('created_at', { ascending: true })
  if (subject === 'restaurant' || subject === 'organizer') q = q.eq('subject_type', subject)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ requests: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}
