import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/admin/paid-tickets (R2) — tickets paid by Mobile Money, newest
// first (200), with their refund state. Admin / super admin (only the super
// admin can refund).
export async function GET(req: NextRequest) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const { data, error } = await supabaseAdmin.from('event_reservations')
    .select('id, event_id, customer_name, customer_phone, quantity, total_price, payment_status, payment_id, reservation_status, reservation_code, refund_status, refunded_amount, event_date, created_at, events(title, city)')
    .not('payment_id', 'is', null).in('payment_status', ['paid', 'refunded'])
    .order('created_at', { ascending: false }).limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ tickets: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}
