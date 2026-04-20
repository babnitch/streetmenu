'use client'

import { useEffect, useRef, useState } from 'react'
import { CITIES, useCity } from '@/lib/cityContext'

// Pill-shaped city picker for the top nav. Closed: shows 📍 <city> ▼ on a
// brand-light fill. Open: absolute-positioned floating panel with the four
// cities. Dismisses on outside click or Escape.
export default function CityDropdown() {
  const { city, setCity } = useCity()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1 bg-brand-light text-brand-dark border border-brand-badge rounded-full px-3 py-1.5 text-sm font-semibold transition-colors hover:bg-brand-badge/40"
      >
        <span aria-hidden="true">📍</span>
        <span className="max-w-[6rem] truncate">{city}</span>
        <span aria-hidden="true" className={`text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute top-full mt-2 left-1/2 -translate-x-1/2 min-w-[10rem] bg-surface border border-divider rounded-2xl shadow-card py-1 z-50"
        >
          {CITIES.map(c => {
            const selected = c === city
            return (
              <button
                key={c}
                role="option"
                aria-selected={selected}
                onClick={() => { setCity(c); setOpen(false) }}
                className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                  selected
                    ? 'bg-brand-light text-brand-darker font-semibold'
                    : 'text-ink-primary hover:bg-surface-muted'
                }`}
              >
                {selected && <span aria-hidden="true" className="mr-2">✓</span>}
                {c}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
