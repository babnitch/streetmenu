'use client'

// A visible search field that filters the list under it in place (N1).
// "Effacer / Clear" shows when there is text.

import { useBi } from '@/lib/languageContext'

export default function SearchField({ value, onChange, placeholder, dark = false }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  /** On the Loisirs dark band: a white field. */
  dark?: boolean
}) {
  const bi = useBi()
  return (
    <div role="search" className={`flex items-center gap-2 bg-white rounded-2xl px-4 py-2.5 ${dark ? 'shadow-sm' : 'border border-divider focus-within:border-brand'}`}>
      <span aria-hidden="true">🔍</span>
      <input type="search" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        aria-label={placeholder} enterKeyHint="search"
        className="flex-1 min-w-0 bg-transparent outline-none text-sm text-ink-primary placeholder-ink-tertiary py-1 [&::-webkit-search-cancel-button]:hidden" />
      {value && (
        <button type="button" onClick={() => onChange('')}
          className="text-xs font-semibold text-brand-darker hover:underline flex-shrink-0">
          {bi('Effacer', 'Clear')}
        </button>
      )}
    </div>
  )
}
