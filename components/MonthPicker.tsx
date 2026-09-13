'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { useBi } from '@/lib/languageContext'
import { addMonths, isPickableDay, lastPickerMonth, monthGrid, monthOf } from '@/lib/eventCalendar'

// fr-FR on the web, like every other event date on the site.
const MONTH_TITLE = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const DAY_LONG    = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const WEEKDAYS: Array<[string, string]> = [
  ['L', 'lundi'], ['M', 'mardi'], ['M', 'mercredi'], ['J', 'jeudi'], ['V', 'vendredi'], ['S', 'samedi'], ['D', 'dimanche'],
]

interface MonthPickerProps {
  today:          string
  selectedDay:    string | null
  eventDays:      Set<string>
  onPick:         (day: string) => void
  onClose:        () => void
  // Focus goes back here when the picker closes.
  returnFocusRef: RefObject<HTMLButtonElement>
}

// Month grid to jump the Events tab to any day up to a year ahead. Mount it
// only while open: each opening then starts on the selected day's month.
// Bottom sheet on phones, centred dialog on wider screens.
export default function MonthPicker({ today, selectedDay, eventDays, onPick, onClose, returnFocusRef }: MonthPickerProps) {
  const bi = useBi()
  const [month, setMonth] = useState(() => monthOf(selectedDay ?? today))
  const gridRef = useRef<HTMLDivElement>(null)

  // Read through a ref so a parent re-render (a new onClose function) never
  // re-runs the effect below and bounces focus back to the calendar button.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // On open: focus the selected day (or the first pickable one) and listen for
  // Escape. On close: hand focus back to the button that opened the picker.
  useEffect(() => {
    const grid = gridRef.current
    const target = grid?.querySelector<HTMLButtonElement>('button[data-selected="true"]')
      ?? grid?.querySelector<HTMLButtonElement>('button[data-day]:not([disabled])')
    target?.focus()

    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    document.addEventListener('keydown', onKeyDown)
    const returnTo = returnFocusRef.current
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      returnTo?.focus()
    }
  }, [returnFocusRef])

  const canGoBack    = month > monthOf(today)
  const canGoForward = month < lastPickerMonth(today)
  const withEvents   = bi('des événements', 'events')

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:px-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="month-picker-title"
        className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-2xl shadow-card px-4 pt-4 pb-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <h2 id="month-picker-title" className="text-base font-bold text-ink-primary">
            {bi('Choisir une date', 'Pick a date')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={bi('Fermer', 'Close')}
            className="h-9 w-9 rounded-full text-ink-secondary hover:bg-surface-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="flex items-center justify-between mb-3">
          <button
            type="button"
            onClick={() => setMonth(addMonths(month, -1))}
            disabled={!canGoBack}
            aria-label={bi('Mois précédent', 'Previous month')}
            className="h-9 w-9 rounded-full text-lg text-ink-primary hover:bg-surface-muted transition-colors disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <p className="text-sm font-semibold text-ink-primary capitalize" aria-live="polite">
            {MONTH_TITLE.format(new Date(`${month}-01T00:00:00Z`))}
          </p>
          <button
            type="button"
            onClick={() => setMonth(addMonths(month, 1))}
            disabled={!canGoForward}
            aria-label={bi('Mois suivant', 'Next month')}
            className="h-9 w-9 rounded-full text-lg text-ink-primary hover:bg-surface-muted transition-colors disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 mb-1 text-center text-[11px] font-semibold text-ink-tertiary">
          {WEEKDAYS.map(([letter, name]) => (
            <abbr key={name} title={name} className="no-underline">{letter}</abbr>
          ))}
        </div>

        <div ref={gridRef} className="grid grid-cols-7 gap-1">
          {monthGrid(month).flat().map((day, i) => {
            if (!day) return <div key={`blank-${i}`} aria-hidden="true" />
            const pickable  = isPickableDay(day, today)
            const selected  = day === selectedDay
            const isToday   = day === today
            const hasEvents = eventDays.has(day)
            return (
              <button
                key={day}
                type="button"
                data-day={day}
                data-selected={selected ? 'true' : undefined}
                disabled={!pickable}
                onClick={() => onPick(day)}
                aria-pressed={selected}
                aria-current={isToday ? 'date' : undefined}
                aria-label={`${DAY_LONG.format(new Date(`${day}T00:00:00Z`))}${hasEvents ? ` — ${withEvents}` : ''}`}
                className={`h-11 rounded-xl flex flex-col items-center justify-center text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                  selected
                    ? 'bg-brand text-white font-bold'
                    : pickable
                      ? `text-ink-primary hover:bg-surface-muted ${isToday ? 'ring-1 ring-inset ring-brand font-semibold' : ''}`
                      : 'text-ink-tertiary opacity-50 cursor-not-allowed'
                }`}
              >
                {Number(day.slice(8))}
                <span
                  aria-hidden="true"
                  className={`mt-0.5 h-1 w-1 rounded-full ${hasEvents ? (selected ? 'bg-white' : 'bg-brand') : 'bg-transparent'}`}
                />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
