// Single source of truth for phone normalization.
// Keep in sync with app/api/whatsapp/incoming/route.ts normalisePhone (which
// Twilio always hands us an already-`+`-prefixed E.164 number, so that path
// is unaffected by the 00-prefix rule here).
//
// Rules (applied in order):
//  1. Strip "whatsapp:" prefix if present.
//  2. Remove everything that isn't a digit or '+'.
//  3. Convert the international "00" prefix to "+":
//     "004915207805231" → "+4915207805231".
//     This is the common dialing convention in Europe. Not applied if the
//     input already starts with '+'.
//  4. If the result starts with a digit (no '+'), prepend '+' so bare
//     national numbers align with the +E.164 format the webhook stores.
//  5. Return '' for inputs that produce no digits (caller decides what to do).

export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = raw.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '')
  if (!s) return ''

  if (!s.startsWith('+') && s.startsWith('00')) {
    s = '+' + s.slice(2)
  }
  if (!s.startsWith('+') && /^\d/.test(s)) {
    s = '+' + s
  }
  return s
}
