import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { EVENT_CATEGORIES } from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

// PATCH /api/subscriptions/[id]
// Body: { categories?: string[] | null, is_active?: boolean }
// Updates the caller's subscription. Categories null/[] = "all categories".
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))

  const { data: existing } = await supabaseAdmin
    .from('event_subscriptions')
    .select('id, customer_id, city, categories, is_active')
    .eq('id', params.id)
    .maybeSingle()
  if (!existing || existing.customer_id !== session.id) {
    return NextResponse.json({ error: 'Abonnement introuvable / Subscription not found' }, { status: 404 })
  }

  const updates: Record<string, unknown> = {}
  if ('categories' in body) {
    if (body.categories === null || (Array.isArray(body.categories) && body.categories.length === 0)) {
      updates.categories = null
    } else if (Array.isArray(body.categories)) {
      const filtered: string[] = body.categories
        .map((c: unknown) => String(c).trim())
        .filter((c: string) => EVENT_CATEGORIES.includes(c as typeof EVENT_CATEGORIES[number]))
      updates.categories = filtered.length === EVENT_CATEGORIES.length ? null : filtered
    }
  }
  if ('is_active' in body) {
    updates.is_active = !!body.is_active
    if (!body.is_active) updates.unsubscribed_at = new Date().toISOString()
    else updates.unsubscribed_at = null
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true, unchanged: true })
  }

  const { error } = await supabaseAdmin
    .from('event_subscriptions')
    .update(updates)
    .eq('id', existing.id)

  if (error) {
    console.error('[subscriptions/[id]] update failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if ('is_active' in updates && updates.is_active === false) {
    await writeAudit({
      action:          'subscription_cancelled',
      targetType:      'customer',
      targetId:        session.id,
      performedBy:     session.id,
      performedByType: 'customer',
      metadata: { subscription_id: existing.id, city: existing.city },
    })
  }
  return NextResponse.json({ ok: true })
}
