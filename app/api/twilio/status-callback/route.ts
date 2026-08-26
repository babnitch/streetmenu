// Twilio delivery-status callback.
//
// Twilio POSTs here every time a message we sent changes state:
//   queued → sent → delivered → read      (WhatsApp; 'read' is WhatsApp-only)
//   queued → sent → undelivered           (reachable number, message dropped)
//   queued → failed                       (rejected outright)
//
// We match the row by MessageSid and update it in place. The StatusCallback
// URL is set per-message in lib/whatsapp.ts / lib/sms.ts (see
// statusCallbackUrl in lib/messageLog.ts).
//
// Always answers 200 + empty TwiML: a non-2xx makes Twilio retry, and a
// retry storm over a row we can't find helps nobody. The one exception is a
// failed signature check, which is a 403.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { normalizeLogNumber, type MessageStatus } from '@/lib/messageLog'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const EMPTY_TWIML   = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
const TWIML_HEADERS = { 'Content-Type': 'text/xml' }

function ok() {
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS })
}

// Twilio's MessageStatus vocabulary is wider than our column's CHECK
// constraint — 'accepted', 'scheduled', 'sending' and 'receiving' all mean
// "still on its way" for our purposes. Anything we don't recognise is
// dropped rather than written, so an unexpected value can't violate the
// constraint and fail the whole update.
const STATUS_MAP: Record<string, MessageStatus> = {
  accepted:    'queued',
  scheduled:   'queued',
  queued:      'queued',
  sending:     'sent',
  sent:        'sent',
  delivered:   'delivered',
  read:        'read',
  failed:      'failed',
  undelivered: 'undelivered',
}

// Delivery is monotonic: Twilio can deliver callbacks out of order, and a
// late 'sent' arriving after 'delivered' must not walk the row backwards.
// Terminal states (failed/undelivered) always win — they carry the error.
const RANK: Record<MessageStatus, number> = {
  queued: 0, sent: 1, delivered: 2, read: 3, failed: 4, undelivered: 4,
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const params  = Object.fromEntries(new URLSearchParams(rawBody))

  // ── Twilio signature validation ────────────────────────────────────────
  // Same scheme as /api/whatsapp/incoming: HMAC-SHA1 over the full URL plus
  // the sorted form fields, keyed by the account auth token. Without it,
  // anyone knowing this URL could mark messages delivered or rewrite costs.
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (authToken) {
    const sig = req.headers.get('x-twilio-signature') ?? ''
    const url = process.env.TWILIO_STATUS_CALLBACK_URL
      ?? `${process.env.NEXT_PUBLIC_BASE_URL ?? 'https://streetmenu.vercel.app'}/api/twilio/status-callback`
    try {
      const twilio = (await import('twilio')).default
      if (!twilio.validateRequest(authToken, sig, url, params)) {
        console.warn('[twilio-status] signature validation FAILED — request rejected.')
        return new NextResponse(EMPTY_TWIML, { status: 403, headers: TWIML_HEADERS })
      }
    } catch (e) {
      console.error('[twilio-status] validateRequest threw:', (e as Error).message)
      return new NextResponse(EMPTY_TWIML, { status: 500, headers: TWIML_HEADERS })
    }
  } else {
    console.warn('[twilio-status] TWILIO_AUTH_TOKEN not set — skipping signature validation (dev mode).')
  }

  const sid       = params['MessageSid'] || params['SmsSid'] || ''
  const rawStatus = (params['MessageStatus'] || params['SmsStatus'] || '').toLowerCase()
  const status    = STATUS_MAP[rawStatus]

  if (!sid) {
    console.warn('[twilio-status] callback with no MessageSid — ignoring.')
    return ok()
  }
  if (!status) {
    console.warn(`[twilio-status] unmapped status "${rawStatus}" for ${sid} — ignoring.`)
    return ok()
  }

  try {
    const { data: existing } = await supabaseAdmin
      .from('message_log')
      .select('id, status')
      .eq('twilio_sid', sid)
      .maybeSingle()

    const errorCode = params['ErrorCode'] || null
    // Twilio sends Price as a negative string ("-0.00790") once billing has
    // settled; it's absent on the earlier callbacks for the same message.
    const priceRaw  = params['Price']
    const price     = priceRaw !== undefined && priceRaw !== '' ? Number(priceRaw) : null

    const patch: Record<string, unknown> = {
      status,
      status_updated_at: new Date().toISOString(),
    }
    if (errorCode) {
      patch.error_code = errorCode
      // Twilio only sends the numeric code here. ErrorMessage is present on
      // some callbacks; when it isn't, the code alone is enough to look up.
      patch.error_message = params['ErrorMessage'] || `Twilio error ${errorCode}`
    }
    if (price !== null && Number.isFinite(price)) patch.cost = Math.abs(price)

    if (!existing) {
      // No row: the send predates this feature, or the insert failed. Create
      // a stub so the delivery receipt (and its cost) isn't lost. Channel is
      // inferred from the `whatsapp:` prefix Twilio echoes back.
      const to = params['To'] ?? ''
      await supabaseAdmin.from('message_log').insert({
        twilio_sid:  sid,
        direction:   'outbound',
        channel:     /^whatsapp:/i.test(to) ? 'whatsapp' : 'sms',
        from_number: normalizeLogNumber(params['From'] ?? ''),
        to_number:   normalizeLogNumber(to),
        ...patch,
      })
      console.log(`[twilio-status] ${sid} → ${status} (stub row created)`)
      return ok()
    }

    const current = existing.status as MessageStatus
    if ((RANK[status] ?? 0) < (RANK[current] ?? 0)) {
      // Out-of-order callback — keep the further-along status but still take
      // the cost, which only arrives on the later billing callback.
      if (patch.cost !== undefined) {
        await supabaseAdmin.from('message_log').update({ cost: patch.cost }).eq('id', existing.id)
      }
      console.log(`[twilio-status] ${sid} late "${status}" behind "${current}" — status kept`)
      return ok()
    }

    const { error } = await supabaseAdmin
      .from('message_log')
      .update(patch)
      .eq('id', existing.id)
    if (error) {
      console.error(`[twilio-status] update failed for ${sid}:`, error.message)
    } else {
      console.log(`[twilio-status] ${sid} → ${status}${errorCode ? ` (error ${errorCode})` : ''}`)
    }
  } catch (e) {
    // Swallow: Twilio must not retry because our DB hiccuped.
    console.error('[twilio-status] handler threw:', (e as Error).message)
  }

  return ok()
}

// Twilio only ever POSTs here. A GET is almost always someone checking the
// URL by hand, so answer plainly instead of 405-ing.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'twilio status callback' })
}
