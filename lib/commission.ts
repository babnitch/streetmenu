// Commission — one place (Prompt P). Pure, client-safe.
//
// Orders (protected payments): commission_order_pct of what is released to
// the restaurant (Admin → Plateforme → Paiements protégés; 0 by default).
// Never more than the amount, never negative, rounded to the franc.

export function percentOf(amount: number, pct: number): number {
  const a = Math.max(0, Math.round(Number(amount) || 0))
  const p = Math.min(100, Math.max(0, Number(pct) || 0))
  return Math.min(a, Math.round((a * p) / 100))
}

export function orderCommission(releasedAmount: number, commissionOrderPct: number): number {
  return percentOf(releasedAmount, commissionOrderPct)
}

// Tickets (events): events.commission_rate, 10 % when unset (or 0, as
// before). Same formula the three ticket paths used.
export const DEFAULT_EVENT_COMMISSION_RATE = 0.10

export function eventCommissionRate(rate: unknown): number {
  return Number(rate ?? DEFAULT_EVENT_COMMISSION_RATE) || DEFAULT_EVENT_COMMISSION_RATE
}

export function ticketCommission(total: number, rate: number): number {
  return total > 0 ? Math.round(total * rate) : 0
}
