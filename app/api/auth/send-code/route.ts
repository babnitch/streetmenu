import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp, normalizeLang, type Lang } from '@/lib/whatsapp'
import { signCodeTicket } from '@/lib/auth'
import { sendSMS } from '@/lib/sms'
import { clientIP } from '@/lib/rateLimit'
import {
  generateCode, normalizeLoginPhone, claimCodeSend, markCodeSendFailed, claimRefusalText,
  SUSPENDED_TEXT, CODE_TTL_MS,
} from '@/lib/authCodes'

type Channel = 'whatsapp' | 'sms'

export const dynamic = 'force-dynamic'

// Twilio's own trial cap (50 messages / 24 h). An SMS fallback would only
// burn credit on top, so it is not attempted.
const TWILIO_DAILY_CAP = '63038'

// POST /api/auth/send-code
// Body: { phone, country?: ISO (default CM), channel?: 'whatsapp' | 'sms', locale?: 'fr' | 'en' }
//
// One step for log in AND sign up: a code goes to any valid number, known or
// not, and the answer never says which (no account lookup by strangers).
// verify-code tells a new number apart afterwards and asks for a first name.
//
// Limits (all in the database, lib/authCodes.ts): 30 s between sends per
// phone, per phone per hour, per IP per hour, and the platform's daily cap.
// A suspended account gets no code.
//
// WhatsApp first; on a WhatsApp failure the code goes by SMS instead —
// except when the failure is a daily cap (ours never sends, Twilio's 63038
// is not retried by SMS).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const channel: Channel = body?.channel === 'sms' ? 'sms' : 'whatsapp'
  const siteLang: Lang = normalizeLang(body?.locale)

  const norm = normalizeLoginPhone(body?.phone, body?.country)
  if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 })
  const phone = norm.phone

  const { data: existing } = await supabaseAdmin
    .from('customers')
    .select('id, status, deleted_at, preferred_language')
    .eq('phone', phone)
    .maybeSingle()
  if (existing && (existing.status === 'suspended' || existing.status === 'deleted' || existing.deleted_at)) {
    return NextResponse.json({ error: SUSPENDED_TEXT(siteLang) }, { status: 403 })
  }
  // The code message speaks the account's language, else the site's.
  const lang: Lang = existing?.preferred_language ? normalizeLang(existing.preferred_language) : siteLang

  const ip = clientIP(req)
  const claim = await claimCodeSend(phone, ip, channel)
  if (!claim.ok) {
    return NextResponse.json({
      error: claimRefusalText(claim.reason, claim.retryAfter, siteLang),
      reason: claim.reason,
      retry_after: claim.retryAfter,
    }, { status: claim.reason === 'error' ? 500 : 429 })
  }

  const code = generateCode()
  await supabaseAdmin.from('verification_codes').delete().eq('phone', phone)
  const { error: insertErr } = await supabaseAdmin.from('verification_codes').insert({
    phone, code, expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(), used: false,
  })
  if (insertErr) {
    console.error('[send-code] insert error:', insertErr.message)
    await markCodeSendFailed(claim.sendId, 'code_insert_failed')
    return NextResponse.json({ error: claimRefusalText('error', 0, siteLang) }, { status: 500 })
  }

  // Tuned for iOS / Android code autofill: the word "code", a colon, and the
  // digits last on their own, with no formatting around them.
  const msg = lang === 'en'
    ? `Tchop & Ndjoka\nYour verification code: ${code}`
    : `Tchop & Ndjoka\nVotre code de vérification : ${code}`

  const failed = (r: { error?: string; errorCode?: string; status: number }) =>
    r.errorCode ?? r.error?.slice(0, 80) ?? `http_${r.status}`

  if (channel === 'sms') {
    const r = await sendSMS(phone, msg, { context: 'verification_code' })
    if (!r.ok) {
      await markCodeSendFailed(claim.sendId, failed(r))
      console.error('[send-code] SMS send failed:', r.error)
      return NextResponse.json({ error: sendFailedText(siteLang) }, { status: 502 })
    }
    return NextResponse.json({ ticket: signCodeTicket(phone), sent: true, channel: 'sms', fallback: false })
  }

  const r = await sendWhatsApp(phone, msg, { context: 'verification_code' })
  if (r.ok) return NextResponse.json({ ticket: signCodeTicket(phone), sent: true, channel: 'whatsapp', fallback: false })

  await markCodeSendFailed(claim.sendId, failed(r))
  if (r.errorCode === TWILIO_DAILY_CAP) {
    console.warn('[send-code] WhatsApp daily cap reached (63038); no SMS fallback')
    return NextResponse.json({ error: claimRefusalText('daily_cap', 0, siteLang), reason: 'daily_cap' }, { status: 429 })
  }

  // Any other WhatsApp failure: one SMS attempt, itself within the limits.
  console.warn('[send-code] WhatsApp send failed, trying SMS:', r.error)
  const fb = await claimCodeSend(phone, ip, 'sms', true)
  if (!fb.ok) {
    return NextResponse.json({ error: claimRefusalText(fb.reason, fb.retryAfter, siteLang), reason: fb.reason }, { status: 429 })
  }
  const s = await sendSMS(phone, msg, { context: 'verification_code' })
  if (!s.ok) {
    await markCodeSendFailed(fb.sendId, failed(s))
    console.error('[send-code] SMS fallback also failed:', s.error)
    return NextResponse.json({ error: sendFailedText(siteLang) }, { status: 502 })
  }
  return NextResponse.json({ ticket: signCodeTicket(phone), sent: true, channel: 'sms', fallback: true })
}

function sendFailedText(lang: Lang): string {
  return lang === 'en'
    ? 'The code could not be sent. Check the number or try again.'
    : 'Le code n\'a pas pu être envoyé. Vérifiez le numéro ou réessayez.'
}
