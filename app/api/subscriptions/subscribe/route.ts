import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { SUBSCRIPTION_CITIES, EVENT_CATEGORIES } from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

// POST /api/subscriptions/subscribe
// Body: { city: string, categories?: string[] | null }
// Idempotent — re-subscribing to the same city updates the existing row
// (categories overwritten, is_active=true, unsubscribed_at cleared).
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const city = String(body?.city ?? '').trim()
  if (!city || !SUBSCRIPTION_CITIES.includes(city as typeof SUBSCRIPTION_CITIES[number])) {
    return NextResponse.json({ error: 'Ville invalide / Invalid city' }, { status: 400 })
  }
  let categories: string[] | null = null
  if (Array.isArray(body?.categories) && body.categories.length > 0) {
    const filtered: string[] = body.categories
      .map((c: unknown) => String(c).trim())
      .filter((c: string) => EVENT_CATEGORIES.includes(c as typeof EVENT_CATEGORIES[number]))
    categories = filtered.length === EVENT_CATEGORIES.length ? null : filtered
  }

  const { data, error } = await supabaseAdmin
    .from('event_subscriptions')
    .upsert({
      customer_id:     session.id,
      city,
      categories,
      is_active:       true,
      unsubscribed_at: null,
    }, { onConflict: 'customer_id,city' })
    .select('id')
    .single()

  if (error || !data) {
    console.error('[subscriptions/subscribe] upsert failed:', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  await writeAudit({
    action:          'subscription_created',
    targetType:      'customer',
    targetId:        session.id,
    performedBy:     session.id,
    performedByType: 'customer',
    metadata: { subscription_id: data.id, city, categories },
  })

  return NextResponse.json({ ok: true, id: data.id })
}
