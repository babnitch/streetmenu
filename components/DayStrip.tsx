'use client'

import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { addDays, stripDays, type DaySelection } from '@/lib/eventCalendar'
import { dateLocale } from '@/lib/eventDate'

const asDate    = (day: string) => new Date(`${day}T00:00:00Z`)
const dayNumber = (day: string) => String(Number(day.slice(8)))

interface DayStripProps {
  today:             string
  selection:         DaySelection
  eventDays:         Set<string>
  onSelect:          (selection: DaySelection) => void
  onOpenCalendar:    () => void
  calendarButtonRef: RefObject<HTMLButtonElement>
}

// The Events-tab day strip: a fixed calendar button, then "Aujourd'hui",
// "Demain" and the following days. A dot marks every day with at least one
// event.
export default function DayStrip({ today, selection, eventDays, onSelect, onOpenCalendar, calendarButtonRef }: DayStripProps) {
  const bi = useBi()
  const { locale } = useLanguage()
  const selectedRef = useRef<HTMLButtonElement>(null)

  // Day labels follow the reader's language. Rebuilt only when it changes —
  // an Intl.DateTimeFormat is expensive to construct.
  const fmt = useMemo(() => {
    const tag = dateLocale(locale)
    return {
      weekdayShort: new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' }),
      monthShort:   new Intl.DateTimeFormat(tag, { month: 'short', timeZone: 'UTC' }),
      dayLong:      new Intl.DateTimeFormat(tag, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
    }
  }, [locale])

  const selectedDay = selection.kind === 'day' ? selection.day : null
  const tomorrow = addDays(today, 1)
  const withEvents = bi('des événements', 'events')

  // Keep the selected pill on screen — a date picked in the calendar can sit
  // weeks along the strip.
  useEffect(() => {
    if (!selectedDay) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
  }, [selectedDay])

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
        {stripDays(today, selectedDay).map(day => {
          const selected = selectedDay === day
          const hasDot = eventDays.has(day)
          const top = day === today
            ? bi("Aujourd'hui", 'Today')
            : day === tomorrow
              ? bi('Demain', 'Tomorrow')
              // The 1st of a month names the month, so the strip reads across month ends.
              : (day.endsWith('-01') ? fmt.monthShort : fmt.weekdayShort).format(asDate(day))
          return (
            <button
              key={day}
              ref={selected ? selectedRef : undefined}
              type="button"
              onClick={() => onSelect({ kind: 'day', day })}
              aria-pressed={selected}
              aria-label={`${fmt.dayLong.format(asDate(day))}${hasDot ? ` — ${withEvents}` : ''}`}
              className={`flex-shrink-0 min-w-[3.5rem] px-3 py-2 rounded-2xl flex flex-col items-center gap-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 ${
                selected ? 'bg-brand text-white' : 'bg-surface-muted text-ink-primary hover:bg-divider'
              }`}
            >
              <span className={`text-[11px] font-semibold leading-none whitespace-nowrap ${selected ? 'text-white' : 'text-ink-secondary'}`}>
                {top}
              </span>
              <span className="text-base font-bold leading-tight tabular-nums whitespace-nowrap">{dayNumber(day)}</span>
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${hasDot ? (selected ? 'bg-white' : 'bg-brand') : 'bg-transparent'}`}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
