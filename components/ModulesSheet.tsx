'use client'

// Admin: a pro's modules as on/off switches (M1). Used for editing a
// restaurant's or an organiser's modules, on the approval screens (approve +
// activate in one step, Commandes / Réservations pre-ticked) and, inline,
// in the admin "new restaurant" form.
//
// Dependencies are handled here (lib/modules.ts toggleModule): ticking
// Paiement ticks Commandes; unticking Commandes unticks Paiement and
// Livraison, and the sheet says so before saving.

import { useState } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { modulesFor, moduleInfo, toggleModule, dependents, type ModuleSubject } from '@/lib/modules'

export function ModuleSwitches({
  subject, value, onChange, disabled,
}: {
  subject: ModuleSubject
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const { locale } = useLanguage()
  const bi = useBi()
  return (
    <ul className="divide-y divide-divider border border-divider rounded-xl overflow-hidden">
      {modulesFor(subject).map(m => {
        const info = moduleInfo(subject, m)!
        const on = value.includes(m)
        const needs = info.needs ? moduleInfo(subject, info.needs) : null
        return (
          <li key={m}>
            <label className={`flex items-start gap-3 px-3 py-2.5 bg-white ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-surface-muted'}`}>
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={e => onChange(toggleModule(subject, value, m, e.target.checked))}
                className="mt-0.5 w-4 h-4 accent-brand flex-shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink-primary">
                  {locale === 'fr' ? info.fr : info.en}
                  {info.soon && <span className="ml-2 text-[10px] font-bold uppercase text-ink-tertiary">{bi('bientôt', 'soon')}</span>}
                </span>
                <span className="block text-xs text-ink-tertiary">
                  {locale === 'fr' ? info.descFr : info.descEn}
                  {needs && ` · ${bi('nécessite', 'needs')} ${locale === 'fr' ? needs.fr : needs.en}`}
                </span>
              </span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}

export default function ModulesSheet({
  subject, title, subtitle, initial, confirmLabel, onConfirm, onClose,
}: {
  subject: ModuleSubject
  title: string
  subtitle?: string
  initial: string[]
  confirmLabel: string
  // Resolves to an error message, or null when done (the sheet then closes).
  onConfirm: (modules: string[]) => Promise<string | null>
  onClose: () => void
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [value, setValue] = useState<string[]>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // What unticking would drop silently — said out loud before saving.
  const removed = initial.filter(m => !value.includes(m))
  const dropped = removed.flatMap(m => dependents(subject, initial, m)).filter(m => removed.includes(m))
  const name = (m: string) => { const i = moduleInfo(subject, m); return i ? (locale === 'fr' ? i.fr : i.en) : m }

  async function confirm() {
    setSaving(true)
    setError('')
    const err = await onConfirm(value)
    setSaving(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90dvh] flex flex-col">
        <div className="px-5 pt-5 pb-3">
          <h2 className="font-bold text-ink-primary">{title}</h2>
          {subtitle && <p className="text-xs text-ink-secondary mt-0.5">{subtitle}</p>}
          <p className="text-xs text-ink-tertiary mt-1">
            {bi('La vitrine (page, menu, horaires, contact) est toujours incluse.', 'The basic page (page, menu, hours, contact) is always included.')}
          </p>
        </div>
        <div className="px-5 overflow-y-auto">
          <ModuleSwitches subject={subject} value={value} onChange={setValue} disabled={saving} />
          {dropped.length > 0 && (
            <p className="text-xs text-warning mt-2">
              ⚠️ {bi('Désactive aussi', 'Also turns off')} : {dropped.map(name).join(', ')}
            </p>
          )}
          {error && <p className="text-xs text-danger mt-2">{error}</p>}
        </div>
        <div className="px-5 py-4 flex gap-2 justify-end border-t border-divider mt-3">
          <button onClick={onClose} disabled={saving} className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:bg-surface-muted">
            {bi('Annuler', 'Cancel')}
          </button>
          <button onClick={confirm} disabled={saving} className="px-4 py-2 rounded-xl text-sm font-semibold bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white">
            {saving ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// Short chips for a row ("Commandes · Paiement · Livraison"), "Vitrine" when none.
export function ModuleChips({ subject, modules }: { subject: ModuleSubject; modules: string[] }) {
  const { locale } = useLanguage()
  const bi = useBi()
  if (modules.length === 0) {
    return <span className="text-xs text-ink-tertiary">{bi('Vitrine seule', 'Basic only')}</span>
  }
  return (
    <span className="flex flex-wrap gap-1">
      {modules.map(m => {
        const i = moduleInfo(subject, m)
        return (
          <span key={m} className="text-[11px] font-semibold bg-brand-light text-brand-darker px-2 py-0.5 rounded-full">
            {i ? (locale === 'fr' ? i.fr : i.en) : m}
          </span>
        )
      })}
    </span>
  )
}
