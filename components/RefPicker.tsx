'use client'

// A form picker from the reference data: the visible values (no icons),
// then "Autre… / Other…" with a text field — the typed proposal goes to
// Admin → Données de référence → Propositions (the server saves the item
// with the closest value meanwhile). `optional` adds an empty choice
// (cuisine: "— non précisé").

import { useBi, useLanguage } from '@/lib/languageContext'
import { useRefData } from '@/lib/useRefData'
import { refList, refFind, type RefKind } from '@/lib/refData'

export const OTHER = '__other__'

const PLACEHOLDER: Record<RefKind, [string, string]> = {
  city: ['Proposez une ville', 'Propose a city'],
  cuisine: ['Proposez un type de cuisine', 'Propose a type of cuisine'],
  event_category: ['Proposez une catégorie', 'Propose a category'],
  place_category: ['Proposez une catégorie', 'Propose a category'],
}

export default function RefPicker({ kind, value, other, onChange, optional = false, className = '', inputClassName = '', name }: {
  kind: RefKind
  /** The selected code ('' = none, OTHER = "Autre…"). */
  value: string
  other: string
  onChange: (value: string, other: string) => void
  optional?: boolean
  className?: string
  inputClassName?: string
  name?: string
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  useRefData()
  const list = refList(kind)
  // A value the item already has but that is now hidden stays shown.
  const current = value && value !== OTHER && !list.some(v => v.code === value) ? refFind(kind, value) : undefined
  const [ph1, ph2] = PLACEHOLDER[kind]
  return (
    <>
      <select name={name} className={className} value={value} onChange={e => onChange(e.target.value, e.target.value === OTHER ? other : '')}>
        <option value="" disabled={!optional}>{optional ? bi('— Non précisé', '— Not specified') : bi('Choisir…', 'Choose…')}</option>
        {current && <option value={current.code}>{locale === 'en' ? current.label_en : current.label_fr}</option>}
        {list.filter(v => !(kind !== 'city' && v.code.toLowerCase() === 'autre')).map(v => (
          <option key={v.code} value={v.code}>{locale === 'en' ? v.label_en : v.label_fr}</option>
        ))}
        <option value={OTHER}>{bi('Autre…', 'Other…')}</option>
      </select>
      {value === OTHER && (
        <input className={`${inputClassName || className} mt-2`} value={other} maxLength={60} autoFocus
          placeholder={bi(ph1, ph2)} onChange={e => onChange(OTHER, e.target.value)} />
      )}
    </>
  )
}

/** The body fields for a picker: { [field]: code, [field_other]: text }. */
export function pickerBody(field: string, value: string, other: string): Record<string, string> {
  return value === OTHER ? { [field]: '', [`${field}_other`]: other.trim() } : { [field]: value, [`${field}_other`]: '' }
}
