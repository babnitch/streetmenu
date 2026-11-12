'use client'

// The admin city filter (lib/adminCity.ts): « Toutes » + the visible cities.

import { useBi } from '@/lib/languageContext'

export default function AdminCityFilter({ city, cities, onChange }: { city: string; cities: string[]; onChange: (c: string) => void }) {
  const bi = useBi()
  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-4" role="group" aria-label={bi('Ville', 'City')}>
      <span className="text-xs font-semibold text-ink-secondary mr-1">📍 {bi('Ville', 'City')}</span>
      {['', ...cities].map(c => (
        <button key={c || 'all'} type="button" aria-pressed={city === c} onClick={() => onChange(c)}
          className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${city === c ? 'bg-ink-primary text-white border-ink-primary' : 'bg-white border-divider text-ink-secondary hover:text-ink-primary'}`}>
          {c || bi('Toutes', 'All')}
        </button>
      ))}
    </div>
  )
}
