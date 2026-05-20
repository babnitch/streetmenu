import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/broadcasts/my
// Returns the caller's recent broadcasts (most recent first), with the
// restaurant name joined when relevant. Used by the /account compose UI to
// show history + status. Empty array for non-customers.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ broadcasts: [] })
  }

  const { data, error } = await supabaseAdmin
    .from('broadcasts')
    .select('id, sender_type, restaurant_id, title, message, target_city, target_categories, recipient_count, cost, payment_status, status, sent_at, created_at, restaurants(name)')
    .eq('sender_id', session.id)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) {
    console.error('[broadcasts/my] list failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ broadcasts: data ?? [] })
}
