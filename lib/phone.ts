// Single source of truth for phone normalization.
// Keep in sync with app/api/whatsapp/incoming/route.ts normalisePhone.
//
// Rules:
//  - Strip "whatsapp:" prefix if present.
//  - Remove everything that isn't a digit or '+'.
//  - If the result starts with a digit (no '+'), prepend '+'.
//    (A bare national number like "237677..." would otherwise never match
//     rows stored by the WhatsApp webhook as "+237677...".)
//  - Return '' for inputs that produce no digits (caller decides what to do).

export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const stripped = raw.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '')
  if (!stripped) return ''
  if (!stripped.startsWith('+') && /^\d/.test(stripped)) return '+' + stripped
  return stripped
}
