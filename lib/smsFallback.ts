// SMS when WhatsApp can't deliver (D3).
//
// Twilio accepts a WhatsApp message, then reports in its delivery callback
// that it could not deliver it:
//   63016 — outside the 24-hour window (the person hasn't written to us);
//   63015 — on the trial, the number hasn't joined the Twilio sandbox.
// For those two, and only for the messages that matter most, one SMS goes
// out instead (message_log.fallback_sent_at makes it once only):
//   - login codes, customer and team (the still-valid code, within the send
//     limits — team codes outside the daily cap);
//   - payment confirmed (customer) and new paid order (restaurant);
//   - booking confirmed (customer).
// Everything else stays WhatsApp only (decision D). SMS texts are short —
// one or two segments — with a link for the details.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendSMS } from '@/lib/sms'
import { getLangByPhone, pickLang, type Lang } from '@/lib/whatsapp'
import { samePhone } from '@/lib/phone'
import { claimCodeSend, markCodeSendFailed } from '@/lib/authCodes'
import { formatEventDates, formatEventDay, isMultiDay, EVENT_DATE_COLUMNS } from '@/lib/eventDate'

export const FALLBACK_ERROR_CODES = new Set(['63016', '63015'])
const STALE_MS = 30 * 60 * 1000
const BASE_URL = 'https://streetmenu.vercel.app'

export type FallbackOutcome = 'sent' | 'skipped' | 'failed'

interface LogRow {
  id: string; channel: string; context: string | null; to_number: string
  related_id: string | null; body: string | null; fallback_sent_at: string | null; created_at: string
}

const id4 = (id: string) => id.replace(/-/g, '').slice(-4).toUpperCase()

// What to send instead, or null when this message gets no SMS.
async function buildFallback(row: LogRow, phone: string, lang: Lang): Promise<
  { text: string; code?: { purpose: 'customer' | 'team' } } | null
> {
  const now = new Date().toISOString()

  if (row.context === 'verification_code') {
    const team = /équipe \/ team/.test(row.body ?? '')
    if (team) {
      const { data: admin } = await supabaseAdmin.from('admin_users').select('id').eq('phone', phone).maybeSingle()
      if (!admin) return null
      const { data: ch } = await supabaseAdmin.from('admin_login_challenges')
        .select('code').eq('admin_id', admin.id).eq('used', false).gt('expires_at', now)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      return ch ? { text: `Tchop & Ndjoka — équipe / team\nCode de connexion / Login code: ${ch.code}`, code: { purpose: 'team' } } : null
    }
    const { data: vc } = await supabaseAdmin.from('verification_codes')
      .select('code').eq('phone', phone).eq('used', false).gt('expires_at', now)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!vc) return null
    return {
      text: lang === 'en' ? `Tchop & Ndjoka\nYour verification code: ${vc.code}` : `Tchop & Ndjoka\nVotre code de vérification : ${vc.code}`,
      code: { purpose: 'customer' },
    }
  }

  if (row.context === 'payment_confirmation' && row.related_id) {
    const { data: order } = await supabaseAdmin.from('orders')
      .select('id, customer_phone, customer_name, total_price, restaurant_id').eq('id', row.related_id).maybeSingle()
    if (order) {
      const total = Number(order.total_price ?? 0).toLocaleString()
      if (samePhone(phone, order.customer_phone)) {
        const { data: r } = await supabaseAdmin.from('restaurants').select('name').eq('id', order.restaurant_id).maybeSingle()
        return { text: pickLang(
          `Tchop & Ndjoka : paiement reçu, commande #${id4(order.id)} (${r?.name ?? ''}) — ${total} FCFA. Suivi : ${BASE_URL}/account`,
          `Tchop & Ndjoka: payment received, order #${id4(order.id)} (${r?.name ?? ''}) — ${total} FCFA. Track: ${BASE_URL}/account`, lang) }
      }
      return { text: pickLang(
        `Tchop & Ndjoka : nouvelle commande payée #${id4(order.id)} — ${total} FCFA (${order.customer_name ?? ''}). Voir : ${BASE_URL}/dashboard`,
        `Tchop & Ndjoka: new paid order #${id4(order.id)} — ${total} FCFA (${order.customer_name ?? ''}). See: ${BASE_URL}/dashboard`, lang) }
    }
    // A paid booking: the customer's confirmation only (not the organiser's).
    const { data: res } = await supabaseAdmin.from('event_reservations')
      .select('id, event_id, event_date, customer_phone, reservation_code').eq('id', row.related_id).maybeSingle()
    if (res && samePhone(phone, res.customer_phone)) return bookingText(res, lang)
    return null
  }

  if (row.context === 'event_reservation' && row.related_id) {
    // related_id is the event: this is the booker's confirmation when the
    // number booked it in the last 2 hours (organiser pings get no SMS).
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { data: rows } = await supabaseAdmin.from('event_reservations')
      .select('id, event_id, event_date, customer_phone, reservation_code, reservation_status')
      .eq('event_id', row.related_id).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(50)
    const res = (rows ?? []).find(r => samePhone(phone, r.customer_phone as string) && r.reservation_status === 'confirmed')
    return res ? bookingText(res, lang) : null
  }

  return null
}

async function bookingText(
  res: { id: string; event_id: string; event_date: string | null; reservation_code: string | null },
  lang: Lang,
): Promise<{ text: string } | null> {
  const { data: ev } = await supabaseAdmin.from('events').select(`id, title, ${EVENT_DATE_COLUMNS}`).eq('id', res.event_id).maybeSingle()
  if (!ev) return null
  const when = isMultiDay(ev) && res.event_date ? formatEventDay(res.event_date, lang, 'compact') : formatEventDates(ev, lang, 'compact')
  const code = res.reservation_code ?? id4(res.id)
  return { text: pickLang(
    `Tchop & Ndjoka : réservation confirmée #${code} — ${ev.title}, ${when}. Détails : ${BASE_URL}/events/${ev.id}`,
    `Tchop & Ndjoka: booking confirmed #${code} — ${ev.title}, ${when}. Details: ${BASE_URL}/events/${ev.id}`, lang) }
}

// Called from the Twilio delivery callback for a failed WhatsApp message.
export async function smsFallbackForLog(logId: string, errorCode: string | null): Promise<FallbackOutcome> {
  if (!errorCode || !FALLBACK_ERROR_CODES.has(errorCode)) return 'skipped'
  try {
    const { data } = await supabaseAdmin.from('message_log')
      .select('id, channel, context, to_number, related_id, body, fallback_sent_at, created_at').eq('id', logId).maybeSingle()
    const row = data as LogRow | null
    if (!row || row.channel !== 'whatsapp' || row.fallback_sent_at) return 'skipped'
    if (Date.now() - new Date(row.created_at).getTime() > STALE_MS) return 'skipped'

    const phone = row.to_number.replace(/^whatsapp:/i, '')
    const lang = await getLangByPhone(phone)
    const plan = await buildFallback(row, phone, lang)
    if (!plan) return 'skipped'

    // Once only: the callback that sets fallback_sent_at sends.
    const { data: claimed } = await supabaseAdmin.from('message_log')
      .update({ fallback_sent_at: new Date().toISOString() }).eq('id', row.id).is('fallback_sent_at', null).select('id')
    if (!claimed || claimed.length === 0) return 'skipped'

    let sendId: string | null = null
    if (plan.code) {
      const claim = await claimCodeSend(phone, '', 'sms', true, plan.code.purpose)
      if (!claim.ok) {
        console.warn(`[sms-fallback] code SMS refused by limits (${claim.reason}) for log ${row.id}`)
        return 'skipped'
      }
      sendId = claim.sendId
    }
    const r = await sendSMS(phone, plan.text, { context: row.context ?? undefined, relatedId: row.related_id ?? undefined })
    if (!r.ok) {
      if (sendId) await markCodeSendFailed(sendId, r.errorCode ?? r.error?.slice(0, 80) ?? 'sms_failed')
      console.error(`[sms-fallback] SMS failed for log ${row.id}: ${r.error}`)
      return 'failed'
    }
    console.log(`[sms-fallback] ${row.context} → SMS (WhatsApp ${errorCode}) for log ${row.id}`)
    return 'sent'
  } catch (e) {
    console.error('[sms-fallback] threw:', (e as Error).message)
    return 'failed'
  }
}
