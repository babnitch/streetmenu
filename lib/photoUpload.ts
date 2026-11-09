// Photo upload rules shared by the browser forms (lib/uploadPhoto.ts), the
// upload route (/api/upload/image) and the WhatsApp bot. Client-safe.
//   - Only formats every browser can show are ever stored.
//   - Vercel refuses request bodies over 4.5 MB before our code runs, so the
//     limit is 4 MB (room for the form overhead); forms shrink photos first.

export const STORABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

export const PHOTO_MAX_BYTES = 4 * 1024 * 1024

export const PHOTO_TOO_BIG = { fr: 'Photo trop lourde (max 4 Mo)', en: 'Photo too large (max 4 MB)' }
export const PHOTO_BAD_FORMAT = { fr: 'Format non pris en charge, envoyez une photo JPEG ou PNG', en: 'Unsupported format, please send a JPEG or PNG photo' }
export const PHOTO_UPLOAD_FAILED = { fr: 'L\'envoi a échoué, réessayez.', en: 'Upload failed, please try again.' }

export function isStorableImageType(t: string | null | undefined): boolean {
  return (STORABLE_IMAGE_TYPES as readonly string[]).includes((t ?? '').toLowerCase().split(';')[0].trim())
}
