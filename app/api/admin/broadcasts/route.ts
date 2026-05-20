import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/admin/broadcasts
// Query: ?status=pending|sent|failed|all (default: all)
// Returns recent broadcasts with sender + restaurant joined.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const statusFilter = url.searchParams.get('status') ?? 'all'

  let q = supabaseAdmin
    .from('broadcasts')
    .select('id, sender_id, sender_type, restaurant_id, title, message, target_city, target_categories, recipient_count, cost, payment_status, status, sent_at, created_at, customers(name, phone, broadcast_blocked), restaurants(name)')
    .order('created_at', { ascending: false })
    .limit(200)

  if (statusFilter === 'pending') q = q.in('status', ['draft', 'paid', 'sending'])
  else if (statusFilter === 'sent') q = q.eq('status', 'sent')
  else if (statusFilter === 'failed') q = q.eq('status', 'failed')

  const { data, error } = await q
  if (error) {
    console.error('[admin/broadcasts] list failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ broadcasts: data ?? [] })
}
