// "Commandes en ligne en pause": the restaurant stays listed and open, its
// menu stays visible, but no NEW online order is taken (delivery, pickup,
// paid or pay-on-site) until the pause ends. Orders already placed carry on.
//
// Two columns on restaurants (supabase-orders-pause.sql):
//   orders_paused_at    — when the pause started; null = orders open
//   orders_paused_until — when it ends by itself; null = until turned back on
// Nothing has to run at the end of a timed pause: once orders_paused_until is
// in the past the restaurant simply counts as open again.
//
// Never paused by default: a new / published / approved restaurant has
// orders_paused_at = null. Client-safe (no server imports).

export type Lang = 'fr' | 'en'
const pickLang = (fr: string, en: string, lang: Lang | null | undefined): string => (lang === 'en' ? en : fr)

export interface OrdersPauseRow {
  orders_paused_at?: string | null
  orders_paused_until?: string | null
}

export function isOrdersPaused(row: OrdersPauseRow | null | undefined, now: Date = new Date()): boolean {
  if (!row?.orders_paused_at) return false
  if (!row.orders_paused_until) return true
  return new Date(row.orders_paused_until).getTime() > now.getTime()
}

/** The four choices in the pro dashboard (and their bot equivalents). */
export type PauseChoice = '30m' | '1h' | 'closing' | 'manual'
export const PAUSE_CHOICES: readonly PauseChoice[] = ['30m', '1h', 'closing', 'manual']

export function pauseChoiceLabel(c: PauseChoice, lang: Lang): string {
  switch (c) {
    case '30m':     return pickLang('30 min', '30 min', lang)
    case '1h':      return pickLang('1 h', '1 h', lang)
    case 'closing': return pickLang('Jusqu\'à la fermeture ce soir', 'Until tonight\'s closing', lang)
    case 'manual':  return pickLang('Jusqu\'à ce que je réactive', 'Until I turn it back on', lang)
  }
}

/** What the customer sees instead of the order button (web). */
export function ordersPausedTitle(lang: Lang): string {
  return pickLang('Commandes en ligne en pause', 'Online orders paused', lang)
}
export function ordersPausedHint(lang: Lang): string {
  return pickLang('Revenez plus tard ou appelez le restaurant.', 'Come back later or call the restaurant.', lang)
}
/** One line, for API errors and the bot. */
export function ordersPausedText(lang: Lang, restaurantName?: string, phone?: string | null): string {
  const who = restaurantName ? `*${restaurantName}* : ` : ''
  const call = phone ? pickLang(` ou appelez le ${phone}`, ` or call ${phone}`, lang) : pickLang(' ou appelez le restaurant', ' or call the restaurant', lang)
  return pickLang(
    `⏸️ ${who}commandes en pause pour le moment. Revenez plus tard${call}.`,
    `⏸️ ${who}orders are paused for now. Come back later${call}.`,
    lang,
  )
}
export const ORDERS_PAUSED_ERROR = 'Commandes en ligne en pause – revenez plus tard ou appelez le restaurant / Online orders paused – come back later or call the restaurant'

/** "HH:MM" in the restaurant's time zone, for "en pause jusqu'à 21:30". */
export function formatPauseEnd(until: string | null | undefined, timezone: string | null | undefined): string | null {
  if (!until) return null
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone: timezone || 'Africa/Douala', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(until))
  } catch { return null }
}

/**
 * Owner / manager WhatsApp commands:
 *   "pause" → until turned back on; "pause 30" / "pause 30 min" / "pause 1h" /
 *   "pause 2 h" / "pause 1 heure" → that long (5 min – 12 h);
 *   "pause soir" / "pause fermeture" / "pause tonight" / "pause closing" →
 *   until tonight's closing; "reprendre" / "reprise" / "resume" → open again.
 * Anything else that starts with "pause" → { kind: 'bad' } (help reply).
 */
export type BotPauseCommand =
  | { kind: 'pause'; choice: 'manual' | 'closing' }
  | { kind: 'pause'; choice: 'minutes'; minutes: number }
  | { kind: 'resume' }
  | { kind: 'bad' }

export function parseBotPauseCommand(cmd: string): BotPauseCommand | null {
  const c = cmd.trim().toLowerCase().replace(/\s+/g, ' ')
  if (c === 'reprendre' || c === 'reprise' || c === 'resume') return { kind: 'resume' }
  if (c !== 'pause' && !c.startsWith('pause ')) return null
  const rest = c.slice(5).trim()
  if (rest === '') return { kind: 'pause', choice: 'manual' }
  if (['soir', 'ce soir', 'fermeture', 'tonight', 'closing'].includes(rest)) return { kind: 'pause', choice: 'closing' }
  const m = rest.match(/^(\d{1,3})\s*(h|heure|heures|hour|hours|m|min|mins|minute|minutes)?$/)
  if (!m) return { kind: 'bad' }
  const n = Number(m[1])
  const unit = m[2] ?? 'min'
  const minutes = unit.startsWith('h') ? n * 60 : n
  if (minutes < 5 || minutes > 12 * 60) return { kind: 'bad' }
  return { kind: 'pause', choice: 'minutes', minutes }
}
