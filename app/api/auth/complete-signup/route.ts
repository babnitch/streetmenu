import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { setCustomerSession, verifySignupPass } from '@/lib/auth'
import { normalizeLang, type Lang } from '@/lib/whatsapp'
import { sanitizeText } from '@/lib/sanitize'
import { assignWelcomeVoucher } from '@/lib/vouchers'
import { linkGuestData } from '@/lib/guestLink'
import { SUSPENDED_TEXT } from '@/lib/authCodes'

export const dynamic = 'force-dynamic'

// POST /api/auth/complete-signup
// Body: { signupPass, name, locale?, city?, pro?: boolean, pro_name? }
//
// pro: the Pro sign-up path (/login?intent=pro) — the business / association
// name is saved as the Pro profile name and the account opens in Pro mode
// (customers.default_mode = 'pro') on every device.
//
// Last step for a NEW number: verify-code proved the phone and returned a
// 15-minute sign-up pass; this creates the account with the first name only
// (city and language come from the site; everything else is optional, later
// in Account), gives the BIENVENUE welcome voucher, attaches guest orders
// placed with this number, and logs in.
//
// If the account was created meanwhile (double tap, or the bot), it simply
// logs in to it.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const lang: Lang = normalizeLang(body?.locale)

  const phone = verifySignupPass(body?.signupPass)
  if (!phone) {
    return NextResponse.json({
      error: lang === 'en' ? 'Session expired. Ask for a new code.' : 'Session expirée. Demandez un nouveau code.',
    }, { status: 401 })
  }
  const name = sanitizeText(body?.name, 60)
  if (!name) {
    return NextResponse.json({
      error: lang === 'en' ? 'Enter your first name.' : 'Saisissez votre prénom.',
    }, { status: 400 })
  }
  const city = sanitizeText(body?.city, 40)
  const pro = body?.pro === true
  const proName = pro ? sanitizeText(body?.pro_name, 80) : ''
  if (pro && !proName) {
    return NextResponse.json({
      error: lang === 'en' ? 'Enter your business or association name.' : 'Saisissez le nom de votre entreprise ou association.',
    }, { status: 400 })
  }

  const { data: existing } = await supabaseAdmin
    .from('customers').select('id, phone, name, status, deleted_at, default_mode').eq('phone', phone).maybeSingle()
  if (existing) {
    if (existing.status === 'suspended' || existing.status === 'deleted' || existing.deleted_at) {
      return NextResponse.json({ error: SUSPENDED_TEXT(lang) }, { status: 403 })
    }
    await linkGuestData(existing.id, existing.phone)
    const res = NextResponse.json({
      customer: { id: existing.id, phone: existing.phone, name: existing.name },
      isNewAccount: false,
      default_mode: existing.default_mode === 'pro' ? 'pro' : 'client',
    })
    return setCustomerSession(res, existing)
  }

  const { data: created, error } = await supabaseAdmin
    .from('customers')
    .insert({
      phone, name, city, preferred_language: lang,
      ...(pro ? { pro_name: proName, default_mode: 'pro' } : {}),
    })
    .select('id, phone, name')
    .single()
  if (error || !created) {
    // A concurrent sign-up for the same number won the insert: log in to it.
    const { data: raced } = await supabaseAdmin.from('customers').select('id, phone, name').eq('phone', phone).maybeSingle()
    if (raced) {
      const res = NextResponse.json({ customer: raced, isNewAccount: false })
      return setCustomerSession(res, raced)
    }
    console.error('[complete-signup] create customer error:', error?.message)
    return NextResponse.json({
      error: lang === 'en' ? 'Could not create the account. Try again.' : 'Création du compte impossible. Réessayez.',
    }, { status: 500 })
  }

  await assignWelcomeVoucher(created.id)
  const linked = await linkGuestData(created.id, created.phone)
  const res = NextResponse.json({
    customer: created,
    isNewAccount: true,
    welcomeVoucherCode: 'BIENVENUE',
    default_mode: pro ? 'pro' : 'client',
    linkedOrders: linked,
  })
  return setCustomerSession(res, created)
}
