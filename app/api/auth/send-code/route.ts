import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp } from '@/lib/whatsapp'
import { sendSMS } from '@/lib/sms'
import { normalizePhone } from '@/lib/phone'
import { rateLimit, rateLimitedResponse, clientIP } from '@/lib/rateLimit'
import { sanitizeText } from '@/lib/sanitize'

type Channel = 'whatsapp' | 'sms'

export const dynamic = 'force-dynamic'

function generateCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000))
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const phone: string = normalizePhone(body.phone)
  const name: string  = sanitizeText(body.name, 60)
  const city: string  = sanitizeText(body.city, 40)
  // Which channel to deliver the code on. Defaults to WhatsApp (free); the
  // login page also offers SMS explicitly for users without WhatsApp.
  const channel: Channel = body.channel === 'sms' ? 'sms' : 'whatsapp'

  if (!phone) {
    return NextResponse.json({ error: 'Phone required' }, { status: 400 })
  }

  // Per-phone (primary) + per-IP (secondary) rate limit. The phone
  // cap prevents brute-forcing OTPs against a victim; the IP cap
  // catches a script cycling through phones.
  const phoneLimited = rateLimit({ key: `send-code:phone:${phone}`, max: 5, windowMs: 3600_000 })
  if (phoneLimited) return rateLimitedResponse(phoneLimited)
  const ipLimited    = rateLimit({ key: `send-code:ip:${clientIP(req)}`, max: 20, windowMs: 3600_000 })
  if (ipLimited)    return rateLimitedResponse(ipLimited)

  // Check if customer already exists (normalized lookup matches stored format)
  const { data: existing } = await supabaseAdmin
    .from('customers')
    .select('id')
    .eq('phone', phone)
    .maybeSingle()

  // New customer but missing registration fields
  if (!existing && (!name || !city)) {
    return NextResponse.json({ needsRegistration: true })
  }

  // Generate 4-digit code
  const code      = generateCode()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

  // Replace any previous codes for this phone
  await supabaseAdmin.from('verification_codes').delete().eq('phone', phone)
  const { error: insertErr } = await supabaseAdmin.from('verification_codes').insert({
    phone, code, expires_at: expiresAt, used: false,
  })

  if (insertErr) {
    console.error('[send-code] insert error:', insertErr.message)
    return NextResponse.json({ error: 'Failed to generate code' }, { status: 500 })
  }

  // Message body — identical for both channels, and short enough to fit a
  // single SMS segment (< 160 chars).
  //
  // Format is tuned for iOS Security Code AutoFill: the word "code" appears,
  // the digits come right after a colon, and the code is the LAST thing in
  // the message on its own line — with no bold/asterisks or trailing text,
  // any of which stop iOS from surfacing the code above the keyboard. The
  // route has no per-user language, so the label is bilingual on one line
  // and the (unformatted) code closes the message.
  const msg =
    `Tchop & Ndjoka\n` +
    `Votre code de vérification / Your verification code: ${code}`

  // Deliver on the requested channel. If WhatsApp send errors (e.g. the
  // number has no WhatsApp), auto-fall back to SMS and report it so the UI
  // can tell the user. Note: Twilio still returns success for WhatsApp when
  // the recipient silently has no WhatsApp, so this only catches hard send
  // failures — the explicit "Get via SMS" link covers the silent case.
  let usedChannel: Channel = channel
  let fallback = false

  if (channel === 'sms') {
    const r = await sendSMS(phone, msg, { context: 'verification_code' })
    if (!r.ok) {
      console.error('[send-code] SMS send failed:', r.error)
      return NextResponse.json({ error: 'Failed to send SMS code' }, { status: 502 })
    }
  } else {
    const r = await sendWhatsApp(phone, msg, { context: 'verification_code' })
    if (!r.ok) {
      console.warn('[send-code] WhatsApp send failed, falling back to SMS:', r.error)
      const s = await sendSMS(phone, msg, { context: 'verification_code' })
      if (!s.ok) {
        console.error('[send-code] SMS fallback also failed:', s.error)
        return NextResponse.json({ error: 'Failed to send code' }, { status: 502 })
      }
      usedChannel = 'sms'
      fallback = true
    }
  }

  return NextResponse.json({ sent: true, channel: usedChannel, fallback })
}
