import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { setCustomerSession, signSignupPass } from '@/lib/auth'
import { normalizeLang, type Lang } from '@/lib/whatsapp'
import { sanitizeText } from '@/lib/sanitize'
import { normalizeLoginPhone, checkCode, checkRefusalText, claimRefusalText, SUSPENDED_TEXT, CODE_LENGTH } from '@/lib/authCodes'
import { linkGuestData } from '@/lib/guestLink'

export const dynamic = 'force-dynamic'

// POST /api/auth/verify-code
// Body: { phone, country?, code, locale? }
//
// The code is checked in the database (auth_code_check): a wrong code costs
// one of its attempts; at the limit it dies.
//
// Right code:
//   - known number   → logged in (30-day session); guest orders placed with
//                      this number are attached to the account.
//   - new number     → { needsName: true, signupPass }: the login screen asks
//                      ONLY for a first name and finishes with
//                      /api/auth/complete-signup. No account exists until then.
//   - suspended      → refused.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const lang: Lang = normalizeLang(body?.locale)

  const norm = normalizeLoginPhone(body?.phone, body?.country)
  if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 })
  const phone = norm.phone
  const code = sanitizeText(body?.code, 12).replace(/\D/g, '')
  if (code.length !== CODE_LENGTH) {
    return NextResponse.json({
      error: lang === 'en' ? `Enter the ${CODE_LENGTH}-digit code.` : `Saisissez le code à ${CODE_LENGTH} chiffres.`,
    }, { status: 400 })
  }

  const check = await checkCode(phone, code)
  if (!check) return NextResponse.json({ error: claimRefusalText('error', 0, lang) }, { status: 500 })
  if (check.result !== 'ok') {
    return NextResponse.json({ error: checkRefusalText(check, lang), result: check.result }, { status: 400 })
  }

  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, phone, name, status, deleted_at, default_mode')
    .eq('phone', phone)
    .maybeSingle()

  if (!customer) {
    return NextResponse.json({ needsName: true, signupPass: signSignupPass(phone) })
  }
  if (customer.status === 'suspended' || customer.status === 'deleted' || customer.deleted_at) {
    return NextResponse.json({ error: SUSPENDED_TEXT(lang) }, { status: 403 })
  }

  const linked = await linkGuestData(customer.id, customer.phone)
  const res = NextResponse.json({
    customer: { id: customer.id, phone: customer.phone, name: customer.name },
    // The mode this account opens in (Client / Pro), applied by /login.
    default_mode: customer.default_mode === 'pro' ? 'pro' : 'client',
    isNewAccount: false,
    linkedOrders: linked,
  })
  return setCustomerSession(res, customer)
}
