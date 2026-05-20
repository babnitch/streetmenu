import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import {
  findMatchingSubscribers,
  computeBroadcastCost,
  getActivePricing,
  getBroadcastEligibility,
  hasRecentBroadcast,
  SUBSCRIPTION_CITIES,
  EVENT_CATEGORIES,
} from '@/lib/subscriptions'
import { createDeposit, detectMNO, mnoLabel, countryFromCity } from '@/lib/pawapay'

export const dynamic = 'force-dynamic'

// POST /api/broadcasts/create
// Body:
//   {
//     title: string,
//     message: string,                    // ≤1000 chars
//     target_city: string,
//     target_categories?: string[] | null,
//     sender_type: 'publisher' | 'restaurant',
//     restaurant_id?: string,             // required when sender_type=restaurant
//     phone_number: string,               // MoMo wallet to charge
//   }
//
// Inserts a 'draft' broadcast row, kicks off a PawaPay deposit, marks it
// pending. Status → 'paid' on webhook → /api/broadcasts/[id]/send fires
// the fan-out. Caller polls /api/broadcasts/[id] or relies on the webhook.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const title = String(body?.title ?? '').trim()
  const message = String(body?.message ?? '').trim()
  const targetCity = String(body?.target_city ?? '').trim()
  const senderType = body?.sender_type === 'restaurant' ? 'restaurant' : 'publisher'
  const restaurantId = body?.restaurant_id ? String(body.restaurant_id) : null
  const phoneNumber = String(body?.phone_number ?? '').trim()

  if (!title || title.length > 100) {
    return NextResponse.json({ error: 'Titre invalide / Invalid title' }, { status: 400 })
  }
  if (!message || message.length > 1000) {
    return NextResponse.json({ error: 'Message invalide (max 1000 caractères) / Invalid message (max 1000 chars)' }, { status: 400 })
  }
  if (!targetCity || !SUBSCRIPTION_CITIES.includes(targetCity as typeof SUBSCRIPTION_CITIES[number])) {
    return NextResponse.json({ error: 'Ville invalide / Invalid city' }, { status: 400 })
  }
  let categories: string[] | null = null
  if (Array.isArray(body?.target_categories) && body.target_categories.length > 0) {
    const filtered: string[] = body.target_categories
      .map((c: unknown) => String(c).trim())
      .filter((c: string) => EVENT_CATEGORIES.includes(c as typeof EVENT_CATEGORIES[number]))
    categories = filtered.length === EVENT_CATEGORIES.length ? null : filtered
  }
  if (!phoneNumber) {
    return NextResponse.json({ error: 'Numéro de paiement requis / Payment number required' }, { status: 400 })
  }

  // Eligibility + rate limit
  const eligibility = await getBroadcastEligibility(session.id)
  if (eligibility.blocked) {
    return NextResponse.json({ error: 'Diffusion bloquée par l\'administration. / Broadcasting blocked by administration.' }, { status: 403 })
  }
  if (senderType === 'publisher' && !eligibility.asPublisher) {
    return NextResponse.json({ error: 'Vous devez être un éditeur vérifié. / You must be a verified publisher.' }, { status: 403 })
  }
  if (senderType === 'restaurant') {
    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurant_id requis / required' }, { status: 400 })
    }
    if (!eligibility.asRestaurants.some(r => r.id === restaurantId)) {
      return NextResponse.json({ error: 'Vous ne possédez pas ce restaurant. / You do not own this restaurant.' }, { status: 403 })
    }
  }
  if (await hasRecentBroadcast(session.id)) {
    return NextResponse.json({ error: 'Limite: 1 diffusion par jour. / Limit: 1 broadcast per day.' }, { status: 429 })
  }

  // Recipient count + cost (dedup across categories)
  let recipientIds: string[] = []
  if (!categories) {
    const subs = await findMatchingSubscribers({ city: targetCity })
    recipientIds = subs.map(s => s.customer_id)
  } else {
    const seen = new Set<string>()
    for (const cat of categories) {
      const rows = await findMatchingSubscribers({ city: targetCity, category: cat })
      for (const r of rows) seen.add(r.customer_id)
    }
    recipientIds = Array.from(seen)
  }
  const pricing = await getActivePricing()
  const cost = computeBroadcastCost(recipientIds.length, pricing)

  // PawaPay deposit
  const country = countryFromCity(targetCity)
  const mno = detectMNO(phoneNumber, country ?? undefined)
  if (!mno) {
    return NextResponse.json({ error: 'Numéro non supporté / Unsupported phone number' }, { status: 400 })
  }

  // Insert draft row
  const { data: broadcast, error: insErr } = await supabaseAdmin
    .from('broadcasts')
    .insert({
      sender_id:         session.id,
      sender_type:       senderType,
      restaurant_id:     restaurantId,
      title,
      message,
      target_city:       targetCity,
      target_categories: categories,
      recipient_count:   recipientIds.length,
      cost,
      payment_status:    'pending',
      status:            'draft',
    })
    .select('id')
    .single()

  if (insErr || !broadcast) {
    console.error('[broadcasts/create] insert failed:', insErr?.message)
    return NextResponse.json({ error: insErr?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  let depositId: string
  try {
    const result = await createDeposit({
      amount:      cost,
      currency:    mno.currency,
      phoneNumber,
      orderId:     broadcast.id,
      description: `Broadcast ${broadcast.id.slice(0, 6)}`,
    })
    depositId = result.depositId
  } catch (e) {
    const msg = (e as Error).message
    console.error('[broadcasts/create] createDeposit failed:', msg)
    await supabaseAdmin
      .from('broadcasts')
      .update({ payment_status: 'failed', status: 'failed' })
      .eq('id', broadcast.id)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  await supabaseAdmin
    .from('broadcasts')
    .update({ payment_id: depositId })
    .eq('id', broadcast.id)

  await writeAudit({
    action:          'broadcast_created',
    targetType:      'customer',
    targetId:        session.id,
    performedBy:     session.id,
    performedByType: 'customer',
    metadata: {
      broadcast_id:    broadcast.id,
      sender_type:     senderType,
      restaurant_id:   restaurantId,
      target_city:     targetCity,
      target_categories: categories,
      recipient_count: recipientIds.length,
      cost,
      deposit_id:      depositId,
    },
  })

  return NextResponse.json({
    ok: true,
    broadcast_id: broadcast.id,
    deposit_id:   depositId,
    mno:          mno.correspondent,
    mno_label:    mnoLabel(mno.correspondent),
    currency:     mno.currency,
    cost,
    recipients:   recipientIds.length,
  })
}
