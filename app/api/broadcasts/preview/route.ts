import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import {
  getBroadcastEligibility,
  findMatchingSubscribers,
  computeBroadcastCost,
  getActivePricing,
  SUBSCRIPTION_CITIES,
  EVENT_CATEGORIES,
} from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

// POST /api/broadcasts/preview
// Body: { target_city: string, target_categories?: string[] | null }
// Returns recipient count + computed cost without committing anything.
//
// When multiple target_categories are given we de-dupe by customer_id so a
// subscriber who follows two of the targeted categories is only billed once.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  // Broadcast-enabled senders get the full quote. Event organizers who are
  // not enabled still get the audience size — the "who can I reach" card
  // under their event list reads it — but never the cost or pricing.
  // Everyone else is refused.
  const eligibility = await getBroadcastEligibility(session.id)
  const canBroadcast = eligibility.asPublisher || eligibility.asRestaurants.length > 0
  if (!canBroadcast) {
    const { count } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .or(`organizer_id.eq.${session.id},submitted_by.eq.${session.id}`)
    if (!count) {
      return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }
  }

  const body = await req.json().catch(() => ({}))
  const city = String(body?.target_city ?? '').trim()
  if (!city || !SUBSCRIPTION_CITIES.includes(city as typeof SUBSCRIPTION_CITIES[number])) {
    return NextResponse.json({ error: 'Ville invalide / Invalid city' }, { status: 400 })
  }
  let categories: string[] | null = null
  if (Array.isArray(body?.target_categories) && body.target_categories.length > 0) {
    const filtered: string[] = body.target_categories
      .map((c: unknown) => String(c).trim())
      .filter((c: string) => EVENT_CATEGORIES.includes(c as typeof EVENT_CATEGORIES[number]))
    categories = filtered.length === EVENT_CATEGORIES.length ? null : filtered
  }

  let recipients = 0
  if (!categories) {
    const subs = await findMatchingSubscribers({ city })
    recipients = subs.length
  } else {
    const seen = new Set<string>()
    for (const cat of categories) {
      const rows = await findMatchingSubscribers({ city, category: cat })
      for (const r of rows) seen.add(r.customer_id)
    }
    recipients = seen.size
  }

  if (!canBroadcast) return NextResponse.json({ recipients })

  const pricing = await getActivePricing()
  const cost = computeBroadcastCost(recipients, pricing)

  return NextResponse.json({
    recipients,
    cost,
    pricing,
  })
}
