'use client'

// Shared report-flagging UI. Two variants:
//   variant="full"  → wide button used at the bottom of restaurant + event
//                    detail pages ("🚩 Signaler ce restaurant / event").
//   variant="icon"  → compact 🚩 used inline on event comments.
//
// Both open the same modal — reason dropdown + optional description.
// Login-gated by the POST endpoint; we still link the user to /account
// when there's no session to avoid a confusing 401 toast.

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useLanguage, useBi } from '@/lib/languageContext'
import { REPORT_REASONS, type ReportTargetType, type ReportReason } from '@/lib/reports'

interface Props {
  targetType: ReportTargetType
  targetId:   string
  variant?:   'full' | 'icon'
  label?:     string  // override for full variant
}

interface SessionUser { id: string; role: string }

export default function ReportButton({ targetType, targetId, variant = 'full', label }: Props) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [me, setMe] = useState<SessionUser | null>(null)
  const [meLoading, setMeLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<ReportReason>('inappropriate')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (d?.user?.role === 'customer') setMe(d.user) })
      .catch(() => null)
      .finally(() => setMeLoading(false))
  }, [])

  async function submit() {
    if (submitting) return
    setSubmitting(true); setError('')
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_type: targetType,
          target_id:   targetId,
          reason,
          description: description.trim() || undefined,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d?.error ?? bi('Erreur', 'Error')); return }
      setSubmitted(true)
      // Auto-close after a moment so the success state doesn't linger.
      setTimeout(() => { setOpen(false); setSubmitted(false); setDescription('') }, 1800)
    } finally {
      setSubmitting(false)
    }
  }

  // Logged-out users see the trigger; clicking it opens the modal with a
  // login link inside. That way we don't have to re-render the trigger
  // based on auth state (which would flash on hydration).
  const trigger = variant === 'icon' ? (
    <button
      onClick={() => setOpen(true)}
      className="text-ink-tertiary hover:text-rose-600 text-sm leading-none transition-colors"
      aria-label={bi('Signaler', 'Report')}
      title={bi('Signaler', 'Report')}
    >
      🚩
    </button>
  ) : (
    <button
      onClick={() => setOpen(true)}
      className="w-full text-xs text-ink-tertiary hover:text-rose-600 py-2 transition-colors"
    >
      🚩 {label ?? bi('Signaler', 'Report')}
    </button>
  )

  return (
    <>
      {trigger}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => !submitting && setOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5"
            onClick={e => e.stopPropagation()}
          >
            {submitted ? (
              <div className="text-center py-4">
                <div className="text-4xl mb-2">✅</div>
                <p className="font-semibold text-ink-primary">
                  {bi('Signalement envoyé.', 'Report submitted.')}
                </p>
                <p className="text-xs text-ink-tertiary mt-1">
                  {bi('Notre équipe va examiner.', 'Our team will review.')}
                </p>
              </div>
            ) : !meLoading && !me ? (
              <>
                <h3 className="font-bold text-ink-primary mb-1">🚩 {bi('Signaler', 'Report')}</h3>
                <p className="text-sm text-ink-secondary mb-3">
                  {bi('Connectez-vous pour signaler.', 'Log in to submit a report.')}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setOpen(false)}
                    className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-surface-muted text-ink-secondary"
                  >
                    {bi('Annuler', 'Cancel')}
                  </button>
                  <Link
                    href="/account"
                    className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-brand text-white text-center"
                  >
                    {bi('Se connecter', 'Log in')}
                  </Link>
                </div>
              </>
            ) : (
              <>
                <h3 className="font-bold text-ink-primary mb-1">🚩 {bi('Signaler', 'Report')}</h3>
                <p className="text-xs text-ink-tertiary mb-4">
                  {bi(
                    'Anonyme — la partie signalée ne sera pas informée.',
                    'Anonymous — the reported party will not be notified.',
                  )}
                </p>

                <label className="block text-xs text-ink-secondary mb-1">{bi('Raison', 'Reason')}</label>
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value as ReportReason)}
                  className="w-full border border-divider rounded-xl px-3 py-2 text-sm bg-surface mb-3"
                  disabled={submitting}
                >
                  {REPORT_REASONS.map(r => (
                    <option key={r.id} value={r.id}>
                      {locale === 'fr' ? r.fr : r.en}
                    </option>
                  ))}
                </select>

                <label className="block text-xs text-ink-secondary mb-1">
                  {bi('Description (optionnel)', 'Description (optional)')}
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  maxLength={500}
                  rows={3}
                  placeholder={bi('Détails utiles…', 'Helpful details…')}
                  className="w-full border border-divider rounded-xl px-3 py-2 text-sm bg-surface resize-none mb-1"
                  disabled={submitting}
                />
                <p className="text-[10px] text-ink-tertiary text-right mb-2">{description.length}/500</p>

                {error && <p className="text-xs text-danger mb-2">{error}</p>}

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setOpen(false)}
                    disabled={submitting}
                    className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-surface-muted text-ink-secondary hover:bg-divider transition-colors disabled:opacity-50"
                  >
                    {bi('Annuler', 'Cancel')}
                  </button>
                  <button
                    onClick={submit}
                    disabled={submitting}
                    className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-rose-600 text-white hover:bg-rose-700 transition-colors disabled:opacity-50"
                  >
                    {submitting ? '…' : bi('Envoyer', 'Submit')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
