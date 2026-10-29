// Menu as photos or PDF (N4a). Client-safe rules shared by the upload panel,
// the API and the bot (N4b): up to 5 files per restaurant, at most one PDF,
// JPG / PNG / WebP / PDF, 5 MB each. Files live in the public 'menu-files'
// bucket under <restaurant id>/…; rows in restaurant_menu_files.

export const MENU_FILES_BUCKET = 'menu-files'
export const MAX_MENU_FILES = 5
export const MAX_MENU_PDFS = 1
export const MAX_MENU_FILE_BYTES = 5 * 1024 * 1024

export type MenuFileKind = 'photo' | 'pdf'
export interface MenuFile { id: string; url: string; kind: MenuFileKind; position: number; bytes: number }

const TYPES: Record<string, { kind: MenuFileKind; ext: string }> = {
  'image/jpeg':      { kind: 'photo', ext: 'jpg' },
  'image/png':       { kind: 'photo', ext: 'png' },
  'image/webp':      { kind: 'photo', ext: 'webp' },
  'application/pdf': { kind: 'pdf',   ext: 'pdf' },
}

export function menuFileType(contentType: string): { kind: MenuFileKind; ext: string } | null {
  return TYPES[(contentType || '').toLowerCase().split(';')[0].trim()] ?? null
}

// FR / EN reason a new file is refused, or null when it fits.
export function menuFileRefusal(existing: Array<{ kind: MenuFileKind }>, contentType: string, bytes: number): string | null {
  const t = menuFileType(contentType)
  if (!t) return 'Photo JPG, PNG, WebP ou PDF uniquement / JPG, PNG, WebP photo or PDF only'
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Fichier vide / Empty file'
  if (bytes > MAX_MENU_FILE_BYTES) return 'Fichier trop lourd (5 Mo max) / File too large (5 MB max)'
  if (existing.length >= MAX_MENU_FILES) return `${MAX_MENU_FILES} fichiers maximum / ${MAX_MENU_FILES} files at most`
  if (t.kind === 'pdf' && existing.filter(f => f.kind === 'pdf').length >= MAX_MENU_PDFS) {
    return 'Un seul PDF par carte / Only one PDF per menu'
  }
  return null
}

// "Bonjour, je vous contacte via Tchop & Ndjoka" — the WhatsApp greeting
// when a customer contacts a restaurant from its page.
export function contactGreeting(locale: 'fr' | 'en'): string {
  return locale === 'en' ? 'Hello, I am contacting you via Tchop & Ndjoka' : 'Bonjour, je vous contacte via Tchop & Ndjoka'
}
