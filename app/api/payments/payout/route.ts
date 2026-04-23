import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { createPayout, countryFromCity, detectMNO } from '@/lib/pawapay'

export const dynamic = 'force-dynamic'

// POST /api/payments/payout
// Body: { restaurantId: string, amount: number, phoneNumber?: string, description?: string }
//
// Admin-only. Triggers a PawaPay payout to the vendor's MoMo wallet. If
// phoneNumber is omitted, falls back to the restaurant's stored WhatsApp
// number (which is the same wallet for most vendors). Currency is derived
// from the restaurant's city via countryFromCity.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  let body: { restaurantId?: string; amount?: number; phoneNumber?: string; description?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const { restaurantId, amount, phoneNumber, description } = body
  if (!restaurantId || !amount || amount <= 0) {
    return NextResponse.json({ error: 'restaurantId + amount required' }, { status: 400 })
  }

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, city, whatsapp')
    .eq('id', restaurantId)
    .single()
  if (!restaurant) return NextResponse.json({ error: 'Restaurant introuvable / not found' }, { status: 404 })

  const targetPhone = phoneNumber ?? restaurant.whatsapp
  if (!targetPhone) return NextResponse.json({ error: 'Aucun numéro de payout / No payout phone' }, { status: 400 })

  const country = countryFromCity(restaurant.city)
  const mno = detectMNO(targetPhone, country ?? undefined)
  if (!mno) return NextResponse.json({ error: 'Numéro vendeur non supporté / Unsupported vendor number' }, { status: 400 })

  let result
  try {
    result = await createPayout({
      amount:      Math.round(amount),
      currency:    mno.currency,
      phoneNumber: targetPhone,
      description: description ?? `Payout ${restaurant.name}`.slice(0, 22),
    })
  } catch (e) {
    const msg = (e as Error).message
    console.error('[payments/payout] failed:', msg)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  await writeAudit({
    action:           'payout_initiated',
    targetType:       'restaurant',
    targetId:         restaurant.id,
    performedBy:      session.id,
    performedByType:  session.role,
    metadata:         { payout_id: result.payoutId, amount: Math.round(amount), currency: mno.currency, correspondent: result.correspondent },
  })

  return NextResponse.json({
    ok:       true,
    payoutId: result.payoutId,
    status:   result.status,
    amount:   Math.round(amount),
    currency: mno.currency,
  })
}
