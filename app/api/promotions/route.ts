import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import {
  getPromotionEligibility,
  getActivePricing,
  computeCost,
  PLACEMENTS,
  type Placement,
  type TargetType,
} from '@/lib/promotions'
import { createDeposit, detectMNO, mnoLabel, countryFromCity } from '@/lib/pawapay'

export const dynamic = 'force-dynamic'

// POST /api/promotions
// Body: {
//   target_type, target_id, placement, city, start_date, end_date,
//   phone_number    // MoMo wallet to charge
// }
// Inserts a draft row, validates eligibility, computes cost, kicks off
// the PawaPay deposit. On webhook COMPLETED the row flips to
// status='pending_review' for admin approval.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const targetType = body?.target_type as TargetType
  const targetId   = String(body?.target_id ?? '').trim()
  const placement  = body?.placement as Placement
  const city       = String(body?.city ?? '').trim()
  const startDate  = String(body?.start_date ?? '').trim()
  const endDate    = String(body?.end_date ?? '').trim()
  const phoneNumber = String(body?.phone_number ?? '').trim()

  if (!['restaurant', 'event'].includes(targetType)) {
    return NextResponse.json({ error: 'target_type invalide' }, { status: 400 })
  }
  if (!targetId) return NextResponse.json({ error: 'target_id requis' }, { status: 400 })
  if (!PLACEMENTS.includes(placement)) {
    return NextResponse.json({ error: 'placement invalide' }, { status: 400 })
  }
  if (!city) return NextResponse.json({ error: 'city requis' }, { status: 400 })
  if (!startDate || !endDate) return NextResponse.json({ error: 'dates requises' }, { status: 400 })
  if (new Date(endDate).getTime() < new Date(startDate).getTime()) {
    return NextResponse.json({ error: 'end_date < start_date' }, { status: 400 })
  }
  if (!phoneNumber) return NextResponse.json({ error: 'phone_number requis' }, { status: 400 })

  // Eligibility — must own the restaurant or organize the event.
  const elig = await getPromotionEligibility(session.id)
  if (targetType === 'restaurant') {
    if (!elig.restaurants.some(r => r.id === targetId)) {
      return NextResponse.json({ error: 'Vous ne possédez pas ce restaurant / You do not own this restaurant' }, { status: 403 })
    }
  } else {
    if (!elig.events.some(e => e.id === targetId)) {
      return NextResponse.json({ error: 'Vous n\'organisez pas cet événement / You do not organize this event' }, { status: 403 })
    }
  }

  // Pricing + duration validation
  const pricing = await getActivePricing()
  const p = pricing[placement]
  const { days, cost } = computeCost(placement, startDate, endDate, pricing)
  if (days < p.min_duration_days) {
    return NextResponse.json({ error: `Durée minimum ${p.min_duration_days} jour(s) / Min ${p.min_duration_days} day(s)` }, { status: 400 })
  }
  if (days > p.max_duration_days) {
    return NextResponse.json({ error: `Durée maximum ${p.max_duration_days} jours / Max ${p.max_duration_days} days` }, { status: 400 })
  }

  // PawaPay MoMo routing
  const country = countryFromCity(city)
  const mno = detectMNO(phoneNumber, country ?? undefined)
  if (!mno) {
    return NextResponse.json({ error: 'Numéro non supporté / Unsupported phone number' }, { status: 400 })
  }

  // Insert draft row
  const { data: promo, error: insErr } = await supabaseAdmin
    .from('promotions')
    .insert({
      promoter_id:    session.id,
      target_type:    targetType,
      target_id:      targetId,
      placement,
      city,
      start_date:     startDate,
      end_date:       endDate,
      total_budget:   cost,
      payment_status: 'pending',
      status:         'draft',
    })
    .select('id')
    .single()
  if (insErr || !promo) {
    console.error('[promotions/create] insert failed:', insErr?.message)
    return NextResponse.json({ error: insErr?.message ?? 'Erreur' }, { status: 500 })
  }

  // PawaPay deposit
  let depositId: string
  try {
    const result = await createDeposit({
      amount:      cost,
      currency:    mno.currency,
      phoneNumber,
      orderId:     promo.id,
      description: `Promo ${promo.id.slice(0, 6)}`,
    })
    depositId = result.depositId
  } catch (e) {
    const msg = (e as Error).message
    console.error('[promotions/create] createDeposit failed:', msg)
    await supabaseAdmin
      .from('promotions')
      .update({ payment_status: 'failed', status: 'rejected' })
      .eq('id', promo.id)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  await supabaseAdmin
    .from('promotions')
    .update({ payment_id: depositId, updated_at: new Date().toISOString() })
    .eq('id', promo.id)

  await writeAudit({
    action:          'promotion_created',
    targetType:      'promotion',
    targetId:        promo.id,
    performedBy:     session.id,
    performedByType: 'customer',
    metadata:        { target_type: targetType, target_id: targetId, placement, city, days, cost, deposit_id: depositId },
  })

  return NextResponse.json({
    ok: true,
    promotion_id: promo.id,
    deposit_id:   depositId,
    mno:          mno.correspondent,
    mno_label:    mnoLabel(mno.correspondent),
    currency:     mno.currency,
    cost,
    days,
  })
}
