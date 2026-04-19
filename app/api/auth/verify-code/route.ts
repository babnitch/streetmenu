import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { setSessionCookie, SessionPayload } from '@/lib/auth'
import { normalizePhone } from '@/lib/phone'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body  = await req.json()
  const phone: string = normalizePhone(body.phone)
  const code:  string = (body.code  ?? '').trim()
  const name:  string = (body.name  ?? '').trim()
  const city:  string = (body.city  ?? '').trim()

  if (!phone || !code) {
    return NextResponse.json({ error: 'Phone and code required' }, { status: 400 })
  }

  // Find matching, unused, non-expired code
  const { data: record } = await supabaseAdmin
    .from('verification_codes')
    .select('id, expires_at, used')
    .eq('phone', phone)
    .eq('code', code)
    .maybeSingle()

  if (!record) {
    return NextResponse.json({ error: 'Code incorrect / Incorrect code' }, { status: 400 })
  }
  if (record.used) {
    return NextResponse.json({ error: 'Code déjà utilisé / Code already used' }, { status: 400 })
  }
  if (new Date(record.expires_at) < new Date()) {
    return NextResponse.json({ error: 'Code expiré / Code expired' }, { status: 400 })
  }

  // Consume the code
  await supabaseAdmin.from('verification_codes').update({ used: true }).eq('id', record.id)

  // Get or create customer
  let { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, phone, name, city')
    .eq('phone', phone)
    .maybeSingle()

  if (!customer) {
    if (!name || !city) {
      return NextResponse.json(
        { error: 'Nom et ville requis pour les nouveaux comptes / Name and city required for new accounts' },
        { status: 400 }
      )
    }

    const { data: created, error: createErr } = await supabaseAdmin
      .from('customers')
      .insert({ phone, name, city })
      .select('id, phone, name, city')
      .single()

    if (createErr || !created) {
      console.error('[verify-code] create customer error:', createErr?.message)
      return NextResponse.json({ error: 'Failed to create account' }, { status: 500 })
    }

    customer = created

    // Assign welcome voucher to new customers
    const { data: voucher } = await supabaseAdmin
      .from('vouchers')
      .select('id')
      .eq('code', 'BIENVENUE10')
      .maybeSingle()

    if (voucher) {
      await supabaseAdmin
        .from('customer_vouchers')
        .insert({ customer_id: customer.id, voucher_id: voucher.id })
    }
  }

  const rememberMe = Boolean(body.rememberMe)
  const payload: SessionPayload = {
    id:    customer.id,
    phone: customer.phone,
    name:  customer.name,
    role:  'customer',
  }
  const res = NextResponse.json({ customer })
  return setSessionCookie(res, payload, rememberMe)
}
