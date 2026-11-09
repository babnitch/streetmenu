// Admin → Restaurants / Événements: change the photos of an EXISTING row
// (restaurant cover + logo, event poster) and the optional photo credit.
// Pure checks shared by the two admin routes; the routes write + audit.
//
// A body key that is present = a change: a URL replaces, null / '' removes.
// Removing is allowed (lib/pictureRequired.ts: only creation needs a picture).

import { hasPictureUrl } from '@/lib/pictureRequired'

export const PHOTO_CREDIT_MAX = 120

export type PhotoPatch = Record<string, string | null>
export type PhotoCheck = { ok: true; patch: PhotoPatch } | { ok: false; error: string; field: string }

/** `fields`: the photo columns this row has (image_url, logo_url / cover_photo). */
export function checkPhotoBody(body: Record<string, unknown>, fields: readonly string[]): PhotoCheck {
  const patch: PhotoPatch = {}
  for (const f of fields) {
    if (!(f in body)) continue
    const v = body[f]
    if (v === null || v === '') { patch[f] = null; continue }
    if (!hasPictureUrl(v)) return { ok: false, error: 'Photo invalide (https://…) / Invalid photo (https://…)', field: f }
    patch[f] = (v as string).trim()
  }
  if ('photo_credit' in body) {
    const c = body.photo_credit
    if (c !== null && typeof c !== 'string') return { ok: false, error: 'Crédit invalide / Invalid credit', field: 'photo_credit' }
    const t = (c ?? '').replace(/\s+/g, ' ').trim()
    if (t.length > PHOTO_CREDIT_MAX) return { ok: false, error: `Crédit trop long (max ${PHOTO_CREDIT_MAX}) / Credit too long (max ${PHOTO_CREDIT_MAX})`, field: 'photo_credit' }
    patch.photo_credit = t || null
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'Rien à changer / Nothing to change', field: '' }
  return { ok: true, patch }
}

/** The blur placeholder follows the picture shown (`hero`): a new hero gets
 *  the upload's blur hash, or none (never the old picture's). */
export function blurFor(oldHero: string | null, newHero: string | null, blurHash: unknown): { blur_hash: string | null } | Record<string, never> {
  if (oldHero === newHero) return {}
  return { blur_hash: newHero && typeof blurHash === 'string' && blurHash ? blurHash : null }
}
