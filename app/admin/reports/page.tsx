'use client'

export const dynamic = 'force-dynamic'

// Admin moderation queue. Lists every report with content preview +
// reporter info + reason; click a row to expand into action buttons.
// PATCH /api/admin/reports/[id] handles all four spec actions through
// the same endpoint:
//   - Mark reviewed       (status='reviewed')
//   - Dismiss             (status='dismissed')
//   - Delete content      (delete_content=true; comments only — restaurant
//                          + customer suspension live on their existing
//                          admin routes and are linked from the panel)
//   - Save admin notes    (admin_notes only)

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useLanguage, useBi } from '@/lib/languageContext'
import {
  REPORT_REASON_LABEL, REPORT_STATUS_PILL, REPORT_STATUSES,
  REPORT_TARGET_ICON,
  type ReportReason, type ReportStatus, type ReportTargetType,
} from '@/lib/reports'

interface ReportRow {
  id:           string
  reporter_id:  string
  target_type:  ReportTargetType
  target_id:    string
  reason:       ReportReason
  description:  string | null
  status:       ReportStatus
  reviewed_by:  string | null
  reviewed_at:  string | null
  admin_notes:  string | null
  created_at:   string
  target_label: string
  preview:      string
  reporter:     { id: string; name: string; phone: string } | null
}

export default function AdminReportsPage() {
  const bi = useBi()
  const { locale } = useLanguage()

  const [rows, setRows]     = useState<ReportRow[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({ pending: 0, reviewed: 0, action_taken: 0, dismissed: 0 })
  const [loading, setLoading] = useState(true)
  const [filter, setFilter]   = useState<ReportStatus | 'all'>('pending')
  const [openId, setOpenId]   = useState<string | null>(null)

  const fetchRows = useCallback(async (status: ReportStatus | 'all') => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/reports?status=${status}`, { cache: 'no-store' })
      const d = await res.json()
      if (Array.isArray(d?.reports)) setRows(d.reports as ReportRow[])
      if (d?.counts) setCounts(d.counts)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchRows(filter) }, [fetchRows, filter])

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-primary">
          🚩 {bi('Signalements', 'Reports')}
          {counts.pending > 0 && (
            <span className="ml-2 text-sm font-semibold bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5 rounded-full align-middle">
              {counts.pending} {bi('en attente', 'pending')}
            </span>
          )}
        </h1>
        <p className="text-sm text-ink-secondary mt-0.5">
          {bi(
            'Modération du contenu signalé par les utilisateurs.',
            'Moderation queue for user-reported content.',
          )}
        </p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm p-3 mb-4 flex items-center gap-1 flex-wrap">
        {REPORT_STATUSES.map(s => {
          const count = s.id === 'all'
            ? Object.values(counts).reduce((a, b) => a + b, 0)
            : counts[s.id] ?? 0
          return (
            <button
              key={s.id}
              onClick={() => setFilter(s.id)}
              className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors ${
                filter === s.id
                  ? 'bg-brand text-white'
                  : 'bg-surface-muted text-ink-secondary hover:bg-divider'
              }`}
            >
              {locale === 'fr' ? s.fr : s.en} ({count})
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="text-center py-12 text-ink-tertiary">…</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3">📭</div>
          <p>{bi('Aucun signalement.', 'No reports.')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(r => (
            <ReportRowCard
              key={r.id}
              row={r}
              open={openId === r.id}
              onToggle={() => setOpenId(prev => prev === r.id ? null : r.id)}
              onChanged={() => fetchRows(filter)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ReportRowCard({
  row, open, onToggle, onChanged,
}: {
  row: ReportRow
  open: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [notes, setNotes] = useState(row.admin_notes ?? '')
  const [saving, setSaving] = useState<null | 'reviewed' | 'dismissed' | 'delete_content' | 'notes'>(null)
  const [error, setError] = useState('')

  // Reset notes when collapsing/expanding a different row so stale draft
  // doesn't leak between cards.
  useEffect(() => { if (open) setNotes(row.admin_notes ?? ''); else setError('') }, [open, row.admin_notes])

  const statusPill = REPORT_STATUS_PILL[row.status]
  const reasonLabel = REPORT_REASON_LABEL[row.reason]
  const targetIcon = REPORT_TARGET_ICON[row.target_type]
  const dateStr = new Date(row.created_at).toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  async function patch(body: Record<string, unknown>, key: typeof saving) {
    if (saving) return
    setSaving(key); setError('')
    try {
      const res = await fetch(`/api/admin/reports/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, admin_notes: notes.trim() || null }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d?.error ?? bi('Erreur', 'Error')); return }
      onChanged()
    } finally {
      setSaving(null)
    }
  }

  const targetLink = row.target_type === 'restaurant' ? `/restaurant/${row.target_id}`
    : row.target_type === 'event'   ? `/events/${row.target_id}`
    : null

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left p-4 hover:bg-surface-muted transition-colors"
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg">{targetIcon}</span>
              <span className="font-semibold text-ink-primary text-sm">{row.target_label}</span>
            </div>
            <p className="text-xs text-ink-tertiary mt-0.5">
              {dateStr} · {bi(`Raison: ${reasonLabel.fr}`, `Reason: ${reasonLabel.en}`)}
            </p>
            {row.preview && (
              <p className="text-xs text-ink-secondary mt-1 line-clamp-2 italic">
                «{row.preview}»
              </p>
            )}
          </div>
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${statusPill.pillCls}`}>
            {locale === 'fr' ? statusPill.fr : statusPill.en}
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-divider p-4 space-y-3 bg-surface-muted/40">
          {row.reporter && (
            <div className="text-xs">
              <p className="text-ink-tertiary uppercase tracking-wide mb-1">
                {bi('Signalé par (admin seulement)', 'Reported by (admin only)')}
              </p>
              <p className="text-ink-primary">
                {row.reporter.name} · <span className="font-mono">{row.reporter.phone}</span>
              </p>
            </div>
          )}

          {row.description && (
            <div className="text-xs">
              <p className="text-ink-tertiary uppercase tracking-wide mb-1">
                {bi('Description', 'Description')}
              </p>
              <p className="text-ink-primary whitespace-pre-wrap">{row.description}</p>
            </div>
          )}

          <div>
            <p className="text-xs text-ink-tertiary uppercase tracking-wide mb-1">
              {bi('Notes admin', 'Admin notes')}
            </p>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              maxLength={1000}
              rows={2}
              className="w-full border border-divider rounded-xl px-3 py-2 text-xs outline-none focus:border-brand bg-white resize-none"
            />
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => patch({ admin_notes: notes }, 'notes')}
              disabled={saving !== null}
              className="text-xs px-3 py-1.5 rounded-full font-semibold bg-surface text-ink-primary border border-divider hover:bg-surface-muted transition-colors disabled:opacity-50"
            >
              {saving === 'notes' ? '…' : bi('💾 Notes', '💾 Notes')}
            </button>
            <button
              onClick={() => patch({ status: 'reviewed' }, 'reviewed')}
              disabled={saving !== null}
              className="text-xs px-3 py-1.5 rounded-full font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50"
            >
              {saving === 'reviewed' ? '…' : bi('✅ Examiné', '✅ Reviewed')}
            </button>
            <button
              onClick={() => patch({ status: 'dismissed' }, 'dismissed')}
              disabled={saving !== null}
              className="text-xs px-3 py-1.5 rounded-full font-semibold bg-surface-muted text-ink-secondary border border-divider hover:bg-divider disabled:opacity-50"
            >
              {saving === 'dismissed' ? '…' : bi('⚪ Ignorer', '⚪ Dismiss')}
            </button>
            {row.target_type === 'comment' && (
              <button
                onClick={() => patch({ delete_content: true }, 'delete_content')}
                disabled={saving !== null}
                className="text-xs px-3 py-1.5 rounded-full font-semibold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-50"
              >
                {saving === 'delete_content' ? '…' : bi('🗑 Supprimer commentaire', '🗑 Delete comment')}
              </button>
            )}
            {targetLink && (
              <Link
                href={targetLink}
                target="_blank"
                className="text-xs px-3 py-1.5 rounded-full font-semibold bg-surface text-brand-darker border border-brand-badge/40 hover:bg-brand-light"
              >
                {bi('🔗 Voir', '🔗 View')}
              </Link>
            )}
          </div>

          {row.target_type !== 'comment' && (
            <p className="text-[10px] text-ink-tertiary italic">
              {bi(
                'Pour suspendre, utilisez la page Restaurants ou Comptes (le contexte y est plus complet).',
                'To suspend, use the Restaurants or Accounts tab (more context there).',
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
