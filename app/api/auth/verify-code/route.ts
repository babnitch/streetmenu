import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { setSessionCookie, SessionPayload } from '@/lib/auth'
import { normalizePhone } from '@/lib/phone'
import { assignWelcomeVoucher } from '@/lib/vouchers'
import { rateLimit, rateLimitedResponse } from '@/lib/rateLimit'
import { sanitizeText } from '@/lib/sanitize'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body  = await req.json()
  const phone: string = normalizePhone(body.phone)
  const code:  string = sanitizeText(body.code, 8).trim()
  const name:  string = sanitizeText(body.name, 60)
  const city:  string = sanitizeText(body.city, 40)

  if (!phone || !code) {
    return NextResponse.json({ error: 'Phone and code required' }, { status: 400 })
  }

  // 10 attempts per phone per hour — caps both a script and a
  // typo-prone user without locking out a legitimate retry.
  const limited = rateLimit({ key: `verify-code:${phone}`, max: 10, windowMs: 3600_000 })
  if (limited) return rateLimitedResponse(limited)

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

  // Get or create customer. Capture the pre-fetch state so we can tell the
  // client whether this verification minted a new account (used to gate
  // the welcome-voucher banner).
  let { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, phone, name, city')
    .eq('phone', phone)
    .maybeSingle()
  const previousCustomer = customer

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
    await assignWelcomeVoucher(customer.id)
  }

  // Treat first-time verification as a new account from the client's POV
  // so /account can show the welcome-voucher banner exactly once.
  const isNewAccount = previousCustomer === null

  const rememberMe = Boolean(body.rememberMe)
  const payload: SessionPayload = {
    id:    customer.id,
    phone: customer.phone,
    name:  customer.name,
    role:  'customer',
  }
  const res = NextResponse.json({ customer, isNewAccount, welcomeVoucherCode: isNewAccount ? 'BIENVENUE' : null })
  return setSessionCookie(res, payload, rememberMe)
}
