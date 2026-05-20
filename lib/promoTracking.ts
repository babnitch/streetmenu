'use client'

// Lightweight tracking helpers used by promoted cards.
//
// Impressions: client-side dedupe of 1-hour-per-promotion via
// sessionStorage so a user refreshing the home page 10 times in a
// minute only contributes a single impression. Server adds no
// further dedupe — sessionStorage is per-tab so a user with two
// open tabs will count once per tab, which is acceptable for our
// analytics fidelity.
//
// Clicks: no dedupe — every click is meaningful and we want them
// all counted.

const IMP_KEY = (id: string) => `tn_imp_${id}`
const IMP_TTL_MS = 60 * 60 * 1000  // 1 hour

export function shouldFireImpression(promotionId: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.sessionStorage.getItem(IMP_KEY(promotionId))
    if (!raw) return true
    const last = Number(raw)
    if (!Number.isFinite(last)) return true
    return Date.now() - last > IMP_TTL_MS
  } catch {
    return false
  }
}

export function markImpressionFired(promotionId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(IMP_KEY(promotionId), String(Date.now()))
  } catch { /* private mode — skip */ }
}

// Fire-and-forget. Failure is fine — analytics integrity isn't critical
// enough to block the user's navigation.
export function fireImpression(promotionId: string): void {
  if (!shouldFireImpression(promotionId)) return
  markImpressionFired(promotionId)
  void fetch(`/api/promotions/${promotionId}/impression`, {
    method:    'POST',
    keepalive: true,
  }).catch(() => null)
}

export function fireClick(promotionId: string): void {
  void fetch(`/api/promotions/${promotionId}/click`, {
    method:    'POST',
    keepalive: true,
  }).catch(() => null)
}
