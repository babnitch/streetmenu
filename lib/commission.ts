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
