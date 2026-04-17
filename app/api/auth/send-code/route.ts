import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

function generateCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000))
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const phone: string = (body.phone ?? '').trim()
  const name: string  = (body.name  ?? '').trim()
  const city: string  = (body.city  ?? '').trim()

  if (!phone) {
    return NextResponse.json({ error: 'Phone required' }, { status: 400 })
  }

  // Check if customer already exists
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
    `🔐 Votre code Ndjoka & Tchop: *${code}*\n` +
    `Valide 5 minutes. / Your code: *${code}*. Valid 5 minutes.`

  await sendWhatsApp(phone, msg)

  return NextResponse.json({ sent: true })
}
