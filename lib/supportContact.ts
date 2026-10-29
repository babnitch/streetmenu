// Our support WhatsApp (client-safe): NEXT_PUBLIC_SUPPORT_WHATSAPP only —
// never the bot number (a Twilio sandbox real users can't write to). Unset
// → '' and the links that use it are hidden.

export const SUPPORT_WHATSAPP = (process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP || '').replace(/\D/g, '')

// "C'est votre restaurant ?" on a managed restaurant's page (N3): a chat
// with support, pre-filled with the restaurant's name and id.
export function claimRestaurantLink(name: string, id: string, locale: 'fr' | 'en'): string | null {
  if (!SUPPORT_WHATSAPP) return null
  const text = locale === 'en'
    ? `Hello, I am the owner of "${name}" on Tchop & Ndjoka (ref ${id.slice(0, 8)}). I would like to manage it / ask for changes.`
    : `Bonjour, je suis le propriétaire de « ${name} » sur Tchop & Ndjoka (réf ${id.slice(0, 8)}). Je souhaite le gérer / demander des modifications.`
  return `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(text)}`
}
