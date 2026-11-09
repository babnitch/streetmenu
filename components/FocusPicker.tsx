'use client'

// « 🎯 Cadrage »: choose which part of a photo shows when a card crops it
// (lib/photoFocus.ts). The preview has the real card's shape; tap or drag on
// it to move the focus point, or use Haut / Bas / Gauche / Droite / Centre.
// Saving is the parent's job (onSave gets "x y", or null for the centre).

import { useRef, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { parseFocus, formatFocus, focusPosition, FOCUS_PRESETS, CENTRE, type Focus } from '@/lib/photoFocus'

/** The card shapes: restaurant cover / logo (home card 176×112), event poster (144×192). */
const SHAPE = { cover: 'w-full max-w-[264px] aspect-[11/7]', poster: 'w-36 aspect-[3/4]' } as const

export default function FocusPicker({ src, value, shape, onSave, busy = false, saveLabel }: {
  src: string
  value: string | null | undefined
  shape: keyof typeof SHAPE
  onSave: (v: string | null) => void
  busy?: boolean
  saveLabel?: string
}) {
  return <Picker src={src} value={value} shape={shape} onSave={onSave} busy={busy} saveLabel={saveLabel} />
}

function Picker({ src, value, shape, onSave, onChange, busy, saveLabel }: {
  src: string; value: string | null | undefined; shape: keyof typeof SHAPE
  onSave?: (v: string | null) => void; onChange?: (v: string | null) => void; busy?: boolean; saveLabel?: string
}) {
  const bi = useBi()
  const box = useRef<HTMLDivElement>(null)
  const [f, setF] = useState<Focus>(() => parseFocus(value) ?? CENTRE)
  const [dragging, setDragging] = useState(false)
  const stored = formatFocus(parseFocus(value) ?? CENTRE)
  const current = formatFocus(f)

  function set(next: Focus) {
    setF(next)
    onChange?.(formatFocus(next))
  }
  function fromPointer(e: React.PointerEvent) {
    const r = box.current?.getBoundingClientRect()
    if (!r || !r.width || !r.height) return
    set({ x: Math.round(((e.clientX - r.left) / r.width) * 100), y: Math.round(((e.clientY - r.top) / r.height) * 100) })
  }

  return (
    <div className="space-y-2">
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label={bi('Point de cadrage : touchez la partie à montrer', 'Focus point: tap the part to show')}
        aria-valuenow={f.x}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${f.x}% ${f.y}%`}
        className={`relative ${SHAPE[shape]} rounded-xl overflow-hidden bg-surface-muted cursor-crosshair touch-none select-none ring-1 ring-divider`}
        onPointerDown={e => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setDragging(true); fromPointer(e) }}
        onPointerMove={e => { if (dragging) fromPointer(e) }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={e => {
          const step = e.shiftKey ? 10 : 5
          const k: Record<string, Focus> = {
            ArrowLeft: { x: Math.max(0, f.x - step), y: f.y }, ArrowRight: { x: Math.min(100, f.x + step), y: f.y },
            ArrowUp: { x: f.x, y: Math.max(0, f.y - step) }, ArrowDown: { x: f.x, y: Math.min(100, f.y + step) },
          }
          if (k[e.key]) { e.preventDefault(); set(k[e.key]) }
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a plain img: the preview must follow the pointer instantly */}
        <img src={src} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover pointer-events-none" style={{ objectPosition: focusPosition(current) }} />
        <span aria-hidden="true" className="absolute w-5 h-5 -ml-2.5 -mt-2.5 rounded-full border-2 border-white bg-brand/70 shadow pointer-events-none"
          style={{ left: `${f.x}%`, top: `${f.y}%` }} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FOCUS_PRESETS.map(p => (
          <button key={p.key} type="button" onClick={() => set(p.f)}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${f.x === p.f.x && f.y === p.f.y ? 'border-brand bg-brand-light text-brand-darker' : 'border-divider bg-white text-ink-secondary'}`}>
            {bi(p.fr, p.en)}
          </button>
        ))}
      </div>
      {onSave && (
        <button type="button" disabled={busy || current === stored} onClick={() => onSave(current)}
          className="text-xs font-semibold px-3 py-1.5 rounded-full border border-brand text-brand-darker bg-white disabled:opacity-40">
          {busy ? '…' : saveLabel ?? bi('Enregistrer le cadrage', 'Save the framing')}
        </button>
      )}
    </div>
  )
}

/** Inside a form saved elsewhere (the organiser's event form). */
export function FocusPickerField({ src, value, shape, onChange }: { src: string; value: string | null | undefined; shape: keyof typeof SHAPE; onChange: (v: string | null) => void }) {
  return <Picker src={src} value={value} shape={shape} onChange={onChange} />
}
