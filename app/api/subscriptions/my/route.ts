import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/subscriptions/my
// Returns the logged-in customer's event subscriptions (active first, then
// inactive). Empty array for non-customers — caller uses this on every page
// load and shouldn't have to special-case anon users.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ subscriptions: [] })
  }

  const { data, error } = await supabaseAdmin
    .from('event_subscriptions')
    .select('id, city, categories, is_active, created_at, unsubscribed_at')
    .eq('customer_id', session.id)
    .order('is_active', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[subscriptions/my] list failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ subscriptions: data ?? [] })
}
