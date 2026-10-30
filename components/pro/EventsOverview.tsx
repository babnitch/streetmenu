'use client'
import HelpTip from '@/components/HelpTip'

// Above "Mes événements": the organiser's overview — upcoming events,
// bookings, tickets, check-ins, revenue / commission / net, fill rate per
// event and per day (/api/pro/events-overview).

import { useEffect, useState } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { formatFCFA } from '@/lib/money'
import { formatEventDay } from '@/lib/eventDate'

interface Day { date: string; sold: number; capacity: number; fill: number | null }
interface Ev { id: string; title: string; date: string; bookings: number; tickets: number; checkins: number; revenue: number; commission: number; net: number; fill: number | null; days: Day[]; views: number }
interface Data { events: Ev[]; totals: { events: number; bookings: number; tickets: number; checkins: number; revenue: number; commission: number; net: number; views: number } }

export default function EventsOverview() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [data, setData] = useState<Data | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { fetch('/api/pro/events-overview', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(setData).catch(() => null) }, [])
  if (!data || data.totals.events === 0) return null
  const t = data.totals
  return (
    <section className="mb-6 space-y-3">
      <h2 className="text-sm font-bold text-ink-primary">📊 {bi('Aperçu — événements à venir', 'Overview — upcoming events')} <HelpTip id="eventsOverview" /></h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <Box label={bi('Événements', 'Events')} value={String(t.events)} />
        <Box label={bi('Réservations', 'Bookings')} value={String(t.bookings)} />
        <Box label={bi('Billets', 'Tickets')} value={String(t.tickets)} />
        <Box label={bi('Entrées validées', 'Check-ins')} value={String(t.checkins)} />
        <Box label={bi('Recettes', 'Revenue')} value={formatFCFA(t.revenue)} />
        <Box label="Commission" value={formatFCFA(t.commission)} />
        <Box label={bi('Net pour vous', 'Net to you')} value={formatFCFA(t.net)} strong />
        <Box label={bi('Vues des pages', 'Page views')} value={String(t.views)} />
      </div>
      <ul className="bg-white rounded-2xl border border-divider divide-y divide-divider">
        {data.events.map(e => (
          <li key={e.id} className="px-3 py-2.5">
            <button type="button" onClick={() => setOpen(open === e.id ? null : e.id)} className="w-full text-left">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-ink-primary truncate">{e.title}</span>
                <span className="text-xs font-bold flex-shrink-0">{e.fill === null ? bi('places illimitées', 'unlimited') : `${e.fill} %`}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-surface-muted overflow-hidden"><div className="h-full bg-brand" style={{ width: `${Math.min(100, e.fill ?? 0)}%` }} /></div>
              <p className="mt-1 text-[11px] text-ink-tertiary">
                {formatEventDay(e.date, locale, 'compact')} · {e.bookings} {bi('résa.', 'bookings')} · {e.tickets} {bi('billets', 'tickets')} · {e.checkins} {bi('entrées', 'check-ins')} · {formatFCFA(e.net)} net
              </p>
            </button>
            {open === e.id && e.days.length > 0 && (
              <ul className="mt-2 space-y-1">
                {e.days.map(d => (
                  <li key={d.date} className="flex items-center gap-2 text-xs">
                    <span className="w-24 flex-shrink-0">{formatEventDay(d.date, locale, 'compact')}</span>
                    <span className="flex-1 h-2 rounded-full bg-surface-muted overflow-hidden"><span className="block h-full bg-brand" style={{ width: `${Math.min(100, d.fill ?? 0)}%` }} /></span>
                    <span className="w-24 text-right">{d.sold}{d.capacity > 0 ? ` / ${d.capacity}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Box({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`rounded-xl p-2.5 ${strong ? 'bg-brand text-white' : 'bg-white border border-divider'}`}>
      <p className={`text-[11px] ${strong ? 'text-white/85' : 'text-ink-tertiary'}`}>{label}</p>
      <p className="font-bold">{value}</p>
    </div>
  )
}
