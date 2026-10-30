'use client'

// "📄 Voir la carte / See the menu" on a restaurant page (N4a). Photos open
// full screen, one per screen, swiped sideways; a PDF opens in the phone's
// own viewer. Low-data mode: no image at all until the button is tapped
// (normally the button carries a small preview of the first photo).

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBi } from '@/lib/languageContext'
import { useDataMode } from '@/lib/dataMode'
import type { MenuFile } from '@/lib/menuFiles'

export default function MenuFilesViewer({ files, onOpen }: { files: MenuFile[]; /** "Voir la carte" tapped (stats). */ onOpen?: () => void }) {
  const bi = useBi()
  const { isLowData } = useDataMode()
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const photos = files.filter(f => f.kind === 'photo')
  const pdf = files.find(f => f.kind === 'pdf') ?? null

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open])

  if (files.length === 0) return null
  const label = bi('Voir la carte', 'See the menu')
  const btn = 'flex items-center gap-3 w-full bg-surface border border-divider hover:border-brand rounded-2xl p-2 pr-4 text-left transition-colors'

  // Only a PDF: the button opens it directly.
  if (photos.length === 0 && pdf) {
    return (
      <a href={pdf.url} target="_blank" rel="noopener noreferrer" className={btn} onClick={() => onOpen?.()}>
        <span className="w-12 h-12 rounded-xl bg-surface-muted flex items-center justify-center text-2xl" aria-hidden="true">📄</span>
        <span className="flex-1 font-semibold text-ink-primary">{label}</span>
        <span className="text-xs text-ink-tertiary">PDF</span>
      </a>
    )
  }

  return (
    <>
      <button type="button" onClick={() => { setIndex(0); setOpen(true); onOpen?.() }} className={btn}>
        <span className="relative w-12 h-12 rounded-xl overflow-hidden bg-surface-muted flex items-center justify-center text-2xl flex-shrink-0" aria-hidden="true">
          {isLowData
            ? '📄'
            // eslint-disable-next-line @next/next/no-img-element
            : <img src={photos[0].url} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />}
        </span>
        <span className="flex-1 font-semibold text-ink-primary">📄 {label}</span>
        <span className="text-xs text-ink-tertiary">
          {photos.length} {photos.length > 1 ? bi('photos', 'photos') : bi('photo', 'photo')}{pdf ? ' + PDF' : ''}
        </span>
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[70] bg-black flex flex-col" role="dialog" aria-modal="true" aria-label={label}>
          <div className="flex items-center justify-between px-4 h-14 text-white flex-shrink-0">
            <span className="text-sm font-semibold">{index + 1} / {photos.length}</span>
            <div className="flex items-center gap-2">
              {pdf && (
                <a href={pdf.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold bg-white/15 px-3 py-1.5 rounded-full">📄 PDF</a>
              )}
              <button type="button" onClick={() => setOpen(false)} aria-label={bi('Fermer', 'Close')}
                className="w-10 h-10 rounded-full bg-white/15 text-xl">✕</button>
            </div>
          </div>
          <div className="flex-1 flex overflow-x-auto snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onScroll={e => { const el = e.currentTarget; setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth))) }}>
            {photos.map(p => (
              <div key={p.id} className="w-full h-full flex-shrink-0 snap-center flex items-center justify-center p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={label} className="max-w-full max-h-full object-contain" />
              </div>
            ))}
          </div>
          {photos.length > 1 && (
            <p className="text-center text-white/60 text-xs pb-4">{bi('Glissez pour voir la suite', 'Swipe for more')}</p>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
