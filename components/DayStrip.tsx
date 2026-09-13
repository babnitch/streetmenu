'use client'

import { useEffect, useRef, type RefObject } from 'react'
import { useBi } from '@/lib/languageContext'
import { addDays, stripDays, weekendDays, type DaySelection } from '@/lib/eventCalendar'

// Day labels stay fr-FR on the web, like every other event date on the site.
const WEEKDAY_SHORT = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', timeZone: 'UTC' })
const MONTH_SHORT   = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' })
const DAY_LONG      = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })

const asDate    = (day: string) => new Date(`${day}T00:00:00Z`)
const dayNumber = (day: string) => String(Number(day.slice(8)))

interface Pill {
  key:      string
  top:      string
  main:     string
  hasDot:   boolean
  selected: boolean
  label:    string
  select:   DaySelection
}

interface DayStripProps {
  today:             string
  selection:         DaySelection
  eventDays:         Set<string>
  onSelect:          (selection: DaySelection) => void
  onOpenCalendar:    () => void
  calendarButtonRef: RefObject<HTMLButtonElement>
}

// The Events-tab day strip: a fixed calendar button, then "Passés",
// "Aujourd'hui", "Demain", "Ce week-end" and the following days. A dot marks
// every day with at least one event.
export default function DayStrip({ today, selection, eventDays, onSelect, onOpenCalendar, calendarButtonRef }: DayStripProps) {
  const bi = useBi()
  const selectedRef = useRef<HTMLButtonElement>(null)

  const selectedDay = selection.kind === 'day' ? selection.day : null
  const tomorrow = addDays(today, 1)
  const weekend = weekendDays(today)
  const withEvents = bi('des événements', 'events')

  const pills: Pill[] = [{
    key:      'past',
    top:      bi('Passés', 'Past'),
    main:     '⏳',
    hasDot:   false,
    selected: selection.kind === 'past',
    label:    bi('Événements passés', 'Past events'),
    select:   { kind: 'past' },
  }]
  for (const day of stripDays(today, selectedDay)) {
    const special = day === today ? bi("Aujourd'hui", 'Today') : day === tomorrow ? bi('Demain', 'Tomorrow') : null
    const hasDot = eventDays.has(day)
    pills.push({
      key:      day,
      // The 1st of a month names the month, so the strip reads across month ends.
      top:      special ?? (day.endsWith('-01') ? MONTH_SHORT : WEEKDAY_SHORT).format(asDate(day)),
      main:     dayNumber(day),
      hasDot,
      selected: selectedDay === day,
      label:    `${DAY_LONG.format(asDate(day))}${hasDot ? ` — ${withEvents}` : ''}`,
      select:   { kind: 'day', day },
    })
    if (day === tomorrow) {
      const weekendHasDot = weekend.some(d => eventDays.has(d))
      pills.push({
        key:      'weekend',
        top:      bi('Ce week-end', 'This weekend'),
        main:     weekend.map(dayNumber).join('–'),
        hasDot:   weekendHasDot,
        selected: selection.kind === 'weekend',
        label:    `${bi('Ce week-end', 'This weekend')}${weekendHasDot ? ` — ${withEvents}` : ''}`,
        select:   { kind: 'weekend' },
      })
    }
  }

  // Keep the selected pill on screen — a date picked in the calendar can sit
  // weeks along the strip.
  const selectionKey = selection.kind === 'day' ? selection.day : selection.kind
  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
  }, [selectionKey])

  return (
    <div className="flex items-stretch gap-2">
      <button
        ref={calendarButtonRef}
        type="button"
        onClick={onOpenCalendar}
        aria-haspopup="dialog"
        aria-label={bi('Choisir une date', 'Pick a date')}
        className="flex-shrink-0 w-12 rounded-2xl border border-divider bg-white text-xl hover:bg-surface-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span aria-hidden="true">📅</span>
      </button>

      <div
        role="group"
        aria-label={bi('Jours', 'Days')}
        className="flex gap-2 overflow-x-auto scrollbar-hide py-0.5"
      >
        {pills.map(pill => (
          <button
            key={pill.key}
            ref={pill.selected ? selectedRef : undefined}
            type="button"
            onClick={() => onSelect(pill.select)}
            aria-pressed={pill.selected}
            aria-label={pill.label}
            className={`flex-shrink-0 min-w-[3.5rem] px-3 py-2 rounded-2xl flex flex-col items-center gap-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 ${
              pill.selected ? 'bg-brand text-white' : 'bg-surface-muted text-ink-primary hover:bg-divider'
            }`}
          >
            <span className={`text-[11px] font-semibold leading-none whitespace-nowrap ${pill.selected ? 'text-white' : 'text-ink-secondary'}`}>
              {pill.top}
            </span>
            <span className="text-base font-bold leading-tight tabular-nums whitespace-nowrap">{pill.main}</span>
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${pill.hasDot ? (pill.selected ? 'bg-white' : 'bg-brand') : 'bg-transparent'}`}
            />
          </button>
        ))}
      </div>
    </div>
  )
}
