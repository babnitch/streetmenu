// One way to write money everywhere: "3 000 FCFA" — whole francs, thousands
// grouped by a space, never decimals, never another currency. Client-safe.
//
// The group separator is a no-break space (U+00A0): it reads as a space but
// a price never wraps between "3" and "000" (screens, WhatsApp, SMS alike).

const GROUP = ' '

// "3 000" (no currency) — for inputs' hints, struck-through prices, etc.
export function formatAmount(value: number | string | null | undefined): string {
  const n = Math.round(Number(value ?? 0))
  if (!Number.isFinite(n)) return '0'
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, GROUP)
  return n < 0 ? `-${digits}` : digits
}

// "3 000 FCFA"
export function formatFCFA(value: number | string | null | undefined): string {
  return `${formatAmount(value)}${GROUP}FCFA`
}
