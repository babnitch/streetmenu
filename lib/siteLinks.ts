// Website links for the end of customer WhatsApp confirmations: one line,
// in the same message (never an extra message). Phones open them, so they
// point at the mobile sections of Mon compte.

import { pickLang, type Lang } from '@/lib/whatsapp'

export const SITE_URL = (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://streetmenu.vercel.app').replace(/\/$/, '')

export const ORDERS_URL = `${SITE_URL}/account?tab=orders`
export const BOOKINGS_URL = `${SITE_URL}/account?tab=bookings`

// "🔗 Suivre votre commande : https://…/account?tab=orders"
export function orderLinkLine(lang: Lang): string {
  return `🔗 ${pickLang('Suivre votre commande', 'Track your order', lang)} : ${ORDERS_URL}`
}

// "🔗 Vos réservations : https://…/account?tab=bookings"
export function bookingLinkLine(lang: Lang): string {
  return `🔗 ${pickLang('Vos réservations', 'Your bookings', lang)} : ${BOOKINGS_URL}`
}
