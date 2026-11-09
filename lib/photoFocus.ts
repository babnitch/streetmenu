// Photo focus point: which part of a photo shows when the box crops it (CSS
// object-position). Stored per photo as "x y" in percent — restaurants
// image_focus (cover) + logo_focus, events cover_focus
// (supabase-photo-focus.sql). Empty = the centre. A new photo resets it.
// Client-safe.

export interface Focus { x: number; y: number }
export const CENTRE: Focus = { x: 50, y: 50 }

/** The focus column of each photo column. */
export const FOCUS_OF = { image_url: 'image_focus', logo_url: 'logo_focus', cover_photo: 'cover_focus' } as const
export type PhotoField = keyof typeof FOCUS_OF
export type FocusField = typeof FOCUS_OF[PhotoField]

/** Public, kept OUT of the main public selects (lib/publicColumns.ts):
 *  read through selectWithFocus so the pages work before the SQL has run. */
export { PHOTO_FOCUS_COLUMNS as FOCUS_COLUMNS } from '@/lib/publicColumns'

const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)))

/** "30 70" → { x: 30, y: 70 }; anything else → null. */
export function parseFocus(v: unknown): Focus | null {
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^(\d{1,3}) (\d{1,3})$/)
  if (!m) return null
  const x = Number(m[1]), y = Number(m[2])
  return x <= 100 && y <= 100 ? { x, y } : null
}

/** { x, y } → "30 70"; the centre is stored as null (= default). */
export function formatFocus(f: Focus): string | null {
  const x = clamp(f.x), y = clamp(f.y)
  return x === 50 && y === 50 ? null : `${x} ${y}`
}

/** CSS object-position for a stored value ("50% 50%" when empty). */
export function focusPosition(v: string | null | undefined): string {
  const f = parseFocus(v) ?? CENTRE
  return `${f.x}% ${f.y}%`
}

/** style prop for an <Image> / <img>. */
export const focusStyle = (v: string | null | undefined): { objectPosition: string } => ({ objectPosition: focusPosition(v) })

/** A restaurant shows its cover, else its logo: the focus of the one shown. */
export function heroFocus(r: { image_url?: string | null; image_focus?: string | null; logo_focus?: string | null }): string | null {
  return (r.image_url ? r.image_focus : r.logo_focus) ?? null
}

/** The five quick choices. */
export const FOCUS_PRESETS: Array<{ key: string; fr: string; en: string; f: Focus }> = [
  { key: 'top', fr: 'Haut', en: 'Top', f: { x: 50, y: 0 } },
  { key: 'bottom', fr: 'Bas', en: 'Bottom', f: { x: 50, y: 100 } },
  { key: 'left', fr: 'Gauche', en: 'Left', f: { x: 0, y: 50 } },
  { key: 'right', fr: 'Droite', en: 'Right', f: { x: 100, y: 50 } },
  { key: 'centre', fr: 'Centre', en: 'Centre', f: CENTRE },
]
