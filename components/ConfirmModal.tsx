'use client'

// In-page confirmation dialog. Used instead of window.confirm(), which some
// in-app WebViews (Facebook, Instagram, some Android shells) answer with
// `false` immediately and without showing anything — the button then
// silently "does nothing".

import { useBi } from '@/lib/languageContext'

export default function ConfirmModal({
  title, confirmLabel, confirmClass, children, onCancel, onConfirm,
  cancelLabel, busy = false, error = null,
}: {
  title: string
  confirmLabel: string
  confirmClass: string
  children?: React.ReactNode
  onCancel: () => void
  onConfirm: () => void
  /** Dismiss-button label. Defaults to "Annuler / Cancel" — pass something
   *  else when the action itself is a cancellation. */
  cancelLabel?: string
  /** Disables both buttons while the action runs. */
  busy?: boolean
  /** Shown above the buttons, e.g. the API's refusal. */
  error?: string | null
}) {
  const bi = useBi()
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
        <h3 className="font-bold text-ink-primary mb-4 text-base">{title}</h3>
        {children && <div className="mb-4">{children}</div>}
        {error && <p className="text-xs text-danger mb-3">{error}</p>}
        <div className="flex gap-3">
          <button onClick={onConfirm} disabled={busy}
            className={`flex-1 py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50 ${confirmClass}`}>
            {busy ? '…' : confirmLabel}
          </button>
          <button onClick={onCancel} disabled={busy}
            className="flex-1 bg-surface-muted text-ink-primary py-2.5 rounded-xl font-semibold text-sm hover:bg-divider transition-colors disabled:opacity-50">
            {cancelLabel ?? bi('Annuler', 'Cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
