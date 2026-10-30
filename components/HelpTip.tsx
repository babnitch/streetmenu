'use client'

// ⓘ next to a Pro section title: what the section is for + 2–3 tips
// (lib/proHelp.ts), in a small sheet with ✕. Link to /pro/aide for all.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useBi } from '@/lib/languageContext'
import { PRO_HELP, type ProHelpId } from '@/lib/proHelp'

export default function HelpTip({ id, className = '' }: { id: ProHelpId; className?: string }) {
  const bi = useBi()
  const [open, setOpen] = useState(false)
  const h = PRO_HELP[id]
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <>
      <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
        aria-label={bi(`Aide : ${h.title.fr}`, `Help: ${h.title.en}`)}
        className={`inline-flex items-center justify-center w-5 h-5 rounded-full border border-ink-tertiary/50 text-[11px] font-bold text-ink-secondary hover:bg-surface-muted align-middle ${className}`}>
        i
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[70] flex items-end md:items-center justify-center bg-black/30" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label={bi(h.title.fr, h.title.en)}>
          <div className="bg-white w-full md:max-w-sm rounded-t-3xl md:rounded-2xl p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-bold text-ink-primary">{h.icon} {bi(h.title.fr, h.title.en)}</h3>
              <button type="button" onClick={() => setOpen(false)} aria-label={bi('Fermer', 'Close')} className="w-8 h-8 -mt-1 -mr-1 rounded-full hover:bg-surface-muted text-lg">✕</button>
            </div>
            <p className="mt-2 text-sm text-ink-primary">{bi(h.what.fr, h.what.en)}</p>
            <ul className="mt-3 space-y-1.5 text-sm text-ink-secondary">
              {h.tips.map((t, i) => <li key={i} className="flex gap-2"><span aria-hidden="true">💡</span><span>{bi(t.fr, t.en)}</span></li>)}
            </ul>
            <Link href="/pro/aide" onClick={() => setOpen(false)} className="mt-4 inline-block text-xs font-semibold text-brand-darker hover:underline">{bi('Toute l\'aide Pro', 'All Pro help')} →</Link>
          </div>
        </div>, document.body)}
    </>
  )
}
