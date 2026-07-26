// Twilio SMS — server-only. Used as a fallback channel for verification
// codes when the user doesn't have WhatsApp. Shares the same Twilio
// credentials as lib/whatsapp.ts but sends from a regular phone number
// (no `whatsapp:` prefix).

import type { SendResult } from './whatsapp'

const ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID!
const API_KEY_SID    = process.env.TWILIO_API_KEY_SID!
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET!

// A regular (non-WhatsApp) Twilio number. TWILIO_SMS_NUMBER is preferred;
// TWILIO_PHONE_NUMBER is accepted as an alias for deployments that already
// have a general-purpose Twilio number configured.
const SMS_FROM = process.env.TWILIO_SMS_NUMBER ?? process.env.TWILIO_PHONE_NUMBER ?? ''

// True when a sending number is configured. Callers can use this to decide
// whether to even offer SMS, or to fail fast with a clear message.
export function smsConfigured(): boolean {
  return Boolean(SMS_FROM)
}

// Sends a single SMS via Twilio. Always resolves with a SendResult; never
// throws. Mirrors sendWhatsAppRaw so callers get a uniform shape.
export async function sendSMS(to: string, message: string): Promise<SendResult> {
  if (!SMS_FROM) {
    console.error('[sms] no TWILIO_SMS_NUMBER / TWILIO_PHONE_NUMBER configured — cannot send')
    return { ok: false, status: 0, error: 'SMS number not configured' }
  }
  // SMS uses the bare +E.164 destination — strip any whatsapp: prefix a
  // caller may have carried over.
  const destination = to.replace(/^whatsapp:/i, '')
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`
  const body = new URLSearchParams({ From: SMS_FROM, To: destination, Body: message })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${API_KEY_SID}:${API_KEY_SECRET}`).toString('base64')}`,
      },
      body: body.toString(),
    })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[sms] send FAILED to=${destination} status=${res.status} body=${text.slice(0, 400)}`)
      return { ok: false, status: res.status, error: text.slice(0, 400) }
    }
    try {
      const parsed = JSON.parse(text) as { sid?: string; status?: string }
      console.log(`[sms] send ok to=${destination} sid=${parsed.sid ?? '-'} twilioStatus=${parsed.status ?? '-'}`)
      return { ok: true, status: res.status, sid: parsed.sid, twilioStatus: parsed.status }
    } catch {
      console.log(`[sms] send ok to=${destination} (no JSON body)`)
      return { ok: true, status: res.status }
    }
  } catch (e) {
    const msg = (e as Error).message
    console.error(`[sms] send THREW to=${destination}: ${msg}`)
    return { ok: false, status: 0, error: msg }
  }
}
