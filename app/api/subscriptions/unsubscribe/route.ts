import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/subscriptions/unsubscribe
// Body: { city: string }  → soft-disables the row for that city.
// Body: {}                → soft-disables every subscription.
// Idempotent — already-disabled rows are skipped.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const city = body?.city ? String(body.city).trim() : null

  const q = supabaseAdmin
    .from('event_subscriptions')
    .update({ is_active: false, unsubscribed_at: new Date().toISOString() })
    .eq('customer_id', session.id)
    .eq('is_active', true)

  const { data, error } = city
    ? await q.eq('city', city).select('id, city')
    : await q.select('id, city')

  if (error) {
    console.error('[subscriptions/unsubscribe] update failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  for (const row of data ?? []) {
    await writeAudit({
      action:          'subscription_cancelled',
      targetType:      'customer',
      targetId:        session.id,
      performedBy:     session.id,
      performedByType: 'customer',
      metadata: { subscription_id: row.id, city: row.city },
    })
  }

  return NextResponse.json({ ok: true, count: (data ?? []).length })
}
