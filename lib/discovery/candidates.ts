// "Trouvés cette nuit" (Admin → Événements): the found events waiting for a
// decision, and the message asking the organiser for permission.
// Client-safe (no server imports).

import { formatEventWhen } from '@/lib/eventDate'

export const CANDIDATE_COLUMNS = 'id, source_url, source_domain, other_urls, ticket_url, title, start_date, start_time, end_date, end_time, venue, city, category, price_fcfa, price_is_from, organiser_name, organiser_url, organiser_phone, organiser_email, possible_duplicate_event_id, status, contacted_at, found_at'

export interface EventCandidate {
  id: string
  source_url: string
  source_domain: string
  other_urls: string[]
  ticket_url: string | null
  title: string
  start_date: string
  start_time: string | null
  end_date: string | null
  end_time: string | null
  venue: string | null
  city: string
  category: string | null
  price_fcfa: number | null
  price_is_from: boolean
  organiser_name: string | null
  organiser_url: string | null
  organiser_phone: string | null
  organiser_email: string | null
  possible_duplicate_event_id: string | null
  possible_duplicate_title?: string | null
  status: 'new' | 'contacted' | 'published' | 'ignored'
  contacted_at: string | null
  found_at: string
}

export const IGNORE_REASONS = ['not_relevant', 'duplicate', 'past', 'other'] as const
export type IgnoreReason = typeof IGNORE_REASONS[number]

export const IGNORE_REASON_LABELS: Record<IgnoreReason, { fr: string; en: string }> = {
  not_relevant: { fr: 'Pas pertinent', en: 'Not relevant' },
  duplicate:    { fr: 'Doublon', en: 'Duplicate' },
  past:         { fr: 'Passé', en: 'Past' },
  other:        { fr: 'Autre', en: 'Other' },
}

/** WhatsApp / email text asking to list the event and use the poster. */
export function organiserMessage(c: Pick<EventCandidate, 'title' | 'organiser_name' | 'start_date' | 'start_time' | 'end_date' | 'end_time' | 'venue' | 'city'>, lang: 'fr' | 'en'): string {
  const when = formatEventWhen({ date: c.start_date, end_date: c.end_date, time: null, end_time: null }, lang, 'message')
  const where = c.venue ? (lang === 'fr' ? ` à ${c.venue}` : ` at ${c.venue}`) : ''
  if (lang === 'en') {
    return `Hello${c.organiser_name ? ` ${c.organiser_name}` : ''}, this is the Tchop & Ndjoka team. We saw "${c.title}" on ${when}${where}. `
      + `We'd like to list it for free on our app in ${c.city}, with a link to your ticketing page. May we also use your poster? `
      + 'Reply YES for the listing, and YES POSTER if the poster is OK. Thank you!'
  }
  return `Bonjour${c.organiser_name ? ` ${c.organiser_name}` : ''}, ici l'équipe Tchop & Ndjoka. Nous avons vu « ${c.title} » le ${when}${where}. `
    + `Nous aimerions l'annoncer gratuitement sur notre app à ${c.city}, avec un lien vers votre billetterie. Pouvons-nous aussi utiliser votre affiche ? `
    + 'Répondez OUI pour l\'annonce, et OUI AFFICHE si l\'affiche est d\'accord. Merci !'
}

/** The "Créer un événement" form, pre-filled from a candidate (info only, no poster). */
export function candidateToForm(c: EventCandidate): Record<string, string | boolean> {
  return {
    title: c.title, category: c.category || 'Autre', city: c.city, venue: c.venue ?? '',
    date: c.start_date, time: c.start_time ?? '', end_date: c.end_date ?? '', end_time: c.end_time ?? '',
    price: c.price_fcfa == null ? '' : String(c.price_fcfa), price_is_from: c.price_is_from,
    organizer_name: c.organiser_name ?? '', booking_mode: 'info', info_link: c.ticket_url || c.source_url, publish: true,
  }
}
