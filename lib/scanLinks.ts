// The QR-link line at the end of customer WhatsApp confirmations (Q1): one
// line, in the same message, with the short code as fallback. Server-only.
// If the token can't be made (no SCAN_TOKEN_SECRET), the old account link.

import { pickLang, type Lang } from '@/lib/whatsapp'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { scanUrl } from '@/lib/scanTokens'
import { orderCode } from '@/lib/shortCode'
import { bookingLinkLine, orderLinkLine } from '@/lib/siteLinks'

// The booking a reservation row belongs to (its first row), so all its rows
// share one QR.
export async function bookingIdOf(reservationId: string): Promise<string> {
  const { data } = await supabaseAdmin.from('event_reservations').select('booking_id').eq('id', reservationId).maybeSingle()
  return (data?.booking_id as string | null) ?? reservationId
}

// "🎟 Votre billet : https://…/scan/… (code #AB12)"
export async function bookingQrLine(reservationId: string, code: string, lang: Lang): Promise<string> {
  try {
    const url = await scanUrl('reservation', await bookingIdOf(reservationId))
    return `🎟 ${pickLang('Votre billet', 'Your ticket', lang)} : ${url} (${pickLang('code', 'code', lang)} #${code})`
  } catch (e) {
    console.error('[scanLinks] booking QR line:', (e as Error).message)
    return bookingLinkLine(lang)
  }
}

// "🧾 Votre commande (QR) : https://…/scan/… (code #AB12)"
export async function orderQrLine(orderId: string, lang: Lang): Promise<string> {
  try {
    const url = await scanUrl('order', orderId)
    return `🧾 ${pickLang('Votre commande (QR)', 'Your order (QR)', lang)} : ${url} (${pickLang('code', 'code', lang)} #${orderCode(orderId)})`
  } catch (e) {
    console.error('[scanLinks] order QR line:', (e as Error).message)
    return orderLinkLine(lang)
  }
}
