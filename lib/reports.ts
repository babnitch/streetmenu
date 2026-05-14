// Report taxonomy. Keep the ids in lockstep with the CHECK constraint on
// reports.reason (see supabase-reviews.sql) — adding a new reason here
// without the migration would 500 on insert.

export type ReportTargetType = 'restaurant' | 'event' | 'comment'
export type ReportReason     = 'inappropriate' | 'spam' | 'fake' | 'offensive' | 'fraud' | 'other'
export type ReportStatus     = 'pending' | 'reviewed' | 'action_taken' | 'dismissed'

export const REPORT_REASONS: Array<{ id: ReportReason; fr: string; en: string }> = [
  { id: 'inappropriate', fr: 'Inapproprié',     en: 'Inappropriate' },
  { id: 'spam',          fr: 'Spam',            en: 'Spam' },
  { id: 'fake',          fr: 'Faux contenu',    en: 'Fake content' },
  { id: 'offensive',     fr: 'Offensant',       en: 'Offensive' },
  { id: 'fraud',         fr: 'Fraude',          en: 'Fraud' },
  { id: 'other',         fr: 'Autre',           en: 'Other' },
]
export const REPORT_REASON_LABEL: Record<ReportReason, { fr: string; en: string }> =
  Object.fromEntries(REPORT_REASONS.map(r => [r.id, { fr: r.fr, en: r.en }])) as Record<ReportReason, { fr: string; en: string }>

export const REPORT_STATUSES: Array<{
  id: ReportStatus | 'all'
  fr: string
  en: string
  pillCls: string
}> = [
  { id: 'all',          fr: 'Tous',          en: 'All',          pillCls: '' },
  { id: 'pending',      fr: '🟠 En attente', en: '🟠 Pending',    pillCls: 'bg-amber-50 text-amber-700 border border-amber-200' },
  { id: 'reviewed',     fr: '🟢 Examiné',    en: '🟢 Reviewed',   pillCls: 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
  { id: 'action_taken', fr: '🔴 Action',     en: '🔴 Action taken', pillCls: 'bg-rose-50 text-rose-700 border border-rose-200' },
  { id: 'dismissed',    fr: '⚪ Ignoré',     en: '⚪ Dismissed',  pillCls: 'bg-surface-muted text-ink-secondary border border-divider' },
]
export const REPORT_STATUS_PILL: Record<ReportStatus, { fr: string; en: string; pillCls: string }> = (() => {
  const m: Record<string, { fr: string; en: string; pillCls: string }> = {}
  for (const s of REPORT_STATUSES) if (s.id !== 'all') m[s.id] = { fr: s.fr, en: s.en, pillCls: s.pillCls }
  return m as Record<ReportStatus, { fr: string; en: string; pillCls: string }>
})()

export const REPORT_TARGET_ICON: Record<ReportTargetType, string> = {
  restaurant: '🏪',
  event:      '🎉',
  comment:    '💬',
}

export function isReason(x: unknown): x is ReportReason {
  return typeof x === 'string' && (REPORT_REASONS.map(r => r.id) as string[]).includes(x)
}
export function isTargetType(x: unknown): x is ReportTargetType {
  return x === 'restaurant' || x === 'event' || x === 'comment'
}
