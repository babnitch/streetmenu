// V5: a picture for every NEW restaurant and every NEW event.
//
// One canonical copy of the two messages, shared by the forms (client check,
// "*" labels), the API routes (400 refusals) and the WhatsApp bot. Creation
// only: editing an existing row without a picture is never blocked, and rows
// without one keep the branded placeholder (no DB constraint).

export const RESTAURANT_PHOTO_REQUIRED = {
  fr: 'Ajoutez une photo du restaurant',
  en: 'Add a photo of the restaurant',
} as const

export const EVENT_POSTER_REQUIRED = {
  fr: "Ajoutez une affiche pour l'événement",
  en: 'Add a poster for the event',
} as const

// "FR / EN" form, as the API errors are written (pickBi splits it back).
export const RESTAURANT_PHOTO_REQUIRED_TEXT = `${RESTAURANT_PHOTO_REQUIRED.fr} / ${RESTAURANT_PHOTO_REQUIRED.en}`
export const EVENT_POSTER_REQUIRED_TEXT = `${EVENT_POSTER_REQUIRED.fr} / ${EVENT_POSTER_REQUIRED.en}`

// A usable picture URL: a non-blank http(s) string.
export function hasPictureUrl(input: unknown): input is string {
  return typeof input === 'string' && /^https?:\/\/\S+$/i.test(input.trim())
}
