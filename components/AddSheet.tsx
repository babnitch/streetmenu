'use client'

// "+ Ajouter" sheet (N1): "Que voulez-vous ajouter ?"
//   Un événement        → today's create-event flow (/events/submit)
//   Un lieu à visiter   → N5 (hidden until places exist: PLACES_ENABLED)
//   Mon restaurant ou bar → today's add-restaurant flow
// Opened from the Loisirs page and from the ☰ Pro entry through
// openAddSheet(); the one host lives in TopNav, on every customer page.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'
import { loginHref } from '@/lib/lastPhone'

const OPEN_EVENT = 'nt-open-add-sheet'
export const PLACES_ENABLED = false

export function openAddSheet(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}

export default function AddSheetHost() {
  const bi = useBi()
  const { sessionRole } = useMode()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  const loggedIn = !!sessionRole
  // Logged out: plain login (no silent switch to Pro); the ModeGate then
  // offers "Passer en mode Pro".
  const href = (path: string) => (loggedIn ? path : loginHref(path))
  const close = () => setOpen(false)

  // Portalled to <body>: inside the sticky header (its own stacking
  // context) the bottom bar would cover the sheet.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center" role="dialog" aria-modal="true"
      aria-label={bi('Que voulez-vous ajouter ?', 'What do you want to add?')}>
      <button type="button" aria-label={bi('Fermer', 'Close')} onClick={close} className="absolute inset-0 bg-black/40" />
      <div className="relative w-full md:max-w-md bg-surface rounded-t-3xl md:rounded-3xl shadow-xl p-5 pb-8 md:pb-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-ink-primary">{bi('Que voulez-vous ajouter ?', 'What do you want to add?')}</h2>
          <button type="button" onClick={close} aria-label={bi('Fermer', 'Close')}
            className="w-9 h-9 -mr-2 rounded-full flex items-center justify-center text-xl text-ink-secondary hover:bg-surface-muted">✕</button>
        </div>
        <div className="space-y-2">
          <Choice href={href('/events/submit')} onClick={close} icon="🎉"
            title={bi('Un événement', 'An event')} sub={bi('Concert, soirée, atelier… avec une date', 'Concert, party, workshop… with a date')} />
          {PLACES_ENABLED && (
            <Choice href={href('/places/submit')} onClick={close} icon="🏛️"
              title={bi('Un lieu à visiter', 'A place to visit')} sub={bi('Musée, site, marché… sans date', 'Museum, site, market… no date')} />
          )}
          <Choice href={href('/pro/restaurants/new')} onClick={close} icon="🏪"
            title={bi('Mon restaurant ou bar', 'My restaurant or bar')} sub={bi('Recevez des commandes sur WhatsApp', 'Get orders on WhatsApp')} />
        </div>
        <p className="mt-4 text-xs text-ink-tertiary text-center">
          {bi('Tout est vérifié par notre équipe avant d\'être publié.', 'Everything is checked by our team before it is published.')}
        </p>
      </div>
    </div>,
    document.body,
  )
}

function Choice({ href, onClick, icon, title, sub }: { href: string; onClick: () => void; icon: string; title: string; sub: string }) {
  return (
    <Link href={href} onClick={onClick}
      className="flex items-center gap-3 border border-divider rounded-2xl px-4 py-3 hover:border-brand hover:bg-brand-light/40 transition-colors">
      <span aria-hidden="true" className="text-2xl">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-ink-primary">{title}</span>
        <span className="block text-xs text-ink-tertiary">{sub}</span>
      </span>
      <span aria-hidden="true" className="text-ink-tertiary">›</span>
    </Link>
  )
}
