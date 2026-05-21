import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp } from '@/lib/whatsapp'
import { normalizePhone } from '@/lib/phone'
import { rateLimit, rateLimitedResponse, clientIP } from '@/lib/rateLimit'
import { sanitizeText } from '@/lib/sanitize'

export const dynamic = 'force-dynamic'

function generateCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000))
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const phone: string = normalizePhone(body.phone)
  const name: string  = sanitizeText(body.name, 60)
  const city: string  = sanitizeText(body.city, 40)

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

  // Send via WhatsApp
  const msg =
    `🔐 Votre code Tchop & Ndjoka: *${code}*\n` +
    `Valide 5 minutes. / Your code: *${code}*. Valid 5 minutes.`

  await sendWhatsApp(phone, msg)

  return NextResponse.json({ sent: true })
}
