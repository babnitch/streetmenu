'use client'

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useCity } from '@/lib/cityContext'
import { useLanguage } from '@/lib/languageContext'
import {
  COUNTRIES,
  type CountryISO,
  type CountryMeta,
  getCountryFromCity,
  splitIntoCountryAndLocal,
  formatLocalPhone,
  composeFullPhone,
  validateLocalPhone,
  sortedCountriesFor,
  matchesCountrySearch,
} from '@/lib/phoneValidation'

export interface PhoneInputProps {
  // Stored value (full +E.164). Empty string when blank.
  value: string
  // Fired on every change with the full international number.
  // `meta` carries the structured fields the caller may need
  // (country, local digits, validity).
  onChange: (
    fullPhone: string,
    meta: {
      country:    CountryMeta
      local:      string
      isValid:    boolean
    },
  ) => void
  // Override the city-derived default country. Useful for the MoMo
  // payment input on /order, which defaults from the *restaurant's*
  // city, not the customer's.
  defaultCountry?: CountryISO
  // Pre-pin the country (disables the dropdown). Same use as
  // defaultCountry but explicit — no auto-detect from value.
  fixedCountry?: CountryISO
  placeholder?: string
  disabled?: boolean
  required?: boolean
  autoFocus?: boolean
  autoComplete?: string         // defaults to 'tel-national'
  inputClassName?: string       // tailwind classes appended to the right-side input
  wrapperClassName?: string     // tailwind classes appended to the outer flex row
  id?: string
  name?: string
  // Show inline validation error under the field. Default false because
  // some forms (login OTP) want to surface their own copy instead.
  showError?: boolean
}

// Country selector + local number input combined into one control.
//
// Behaviour:
//  - Country defaults to (in order): `fixedCountry` → `defaultCountry` →
//    detected from `value` → derived from the CityContext.
//  - Typing in the local field strips non-digits and re-formats with
//    spaces using the country's grouping pattern.
//  - Pasting a full +E.164 number (e.g. "+237670000000") is detected —
//    the country flips to match and the local portion is extracted.
//  - `onChange` always emits the full international form to the parent
//    so persistence stays unchanged.
export default function PhoneInput({
  value,
  onChange,
  defaultCountry,
  fixedCountry,
  placeholder,
  disabled,
  required,
  autoFocus,
  autoComplete = 'tel-national',
  inputClassName = '',
  wrapperClassName = '',
  id,
  name,
  showError = false,
}: PhoneInputProps) {
  const { city } = useCity()
  const { locale } = useLanguage()

  // Initial country resolution — runs once, then country becomes
  // user-controlled via the dropdown.
  const initialCountry = useMemo<CountryISO>(() => {
    if (fixedCountry) return fixedCountry
    if (defaultCountry) return defaultCountry
    const detected = splitIntoCountryAndLocal(value).country
    if (detected) return detected.iso
    return getCountryFromCity(city).iso
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [country, setCountry] = useState<CountryISO>(initialCountry)
  const [local, setLocal] = useState<string>(() => splitIntoCountryAndLocal(value).local)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [touched, setTouched] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const wrapperRef = useRef<HTMLDivElement>(null)
  const searchRef  = useRef<HTMLInputElement>(null)

  // Auto-focus the search field when the dropdown opens, so users
  // can start typing a country name without an extra click.
  useEffect(() => {
    if (dropdownOpen) {
      setSearchQuery('')
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [dropdownOpen])

  // Sorted + filtered list driven by city-context and the search box.
  // Sort is stable across renders for a given city so the order doesn't
  // jitter when the search query changes.
  const sortedCountries = useMemo(() => sortedCountriesFor(city), [city])
  const visibleCountries = useMemo(
    () => sortedCountries.filter(c => matchesCountrySearch(c, searchQuery)),
    [sortedCountries, searchQuery],
  )

  // Keep local + country in sync when the parent reassigns `value` to
  // something new (e.g. profile auto-fill after the session resolves).
  // We only re-sync when the incoming value materially differs from our
  // current composed value — otherwise typing would clobber itself.
  useEffect(() => {
    if (!value) {
      // Parent cleared the field — only reset local. Country stays so
      // the user doesn't have to re-pick after a reset.
      if (local !== '') setLocal('')
      return
    }
    const composedHere = composeFullPhone(local, country)
    if (composedHere === value) return
    const split = splitIntoCountryAndLocal(value)
    if (split.country && !fixedCountry) setCountry(split.country.iso)
    setLocal(split.local)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // Close the dropdown when clicking outside.
  useEffect(() => {
    if (!dropdownOpen) return
    function onClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setDropdownOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [dropdownOpen])

  const meta = COUNTRIES[country]
  const validation = validateLocalPhone(local, country)

  const emit = useCallback((nextLocal: string, nextCountry: CountryISO) => {
    const full = composeFullPhone(nextLocal, nextCountry)
    const v = validateLocalPhone(nextLocal, nextCountry)
    onChange(full, {
      country: COUNTRIES[nextCountry],
      local:   nextLocal.replace(/\D/g, ''),
      isValid: v.ok,
    })
  }, [onChange])

  function handleLocalChange(raw: string) {
    // Paste-handling: if the user pasted a full international number,
    // split it instead of treating the +/00 as garbage.
    if (/^(\+|00)/.test(raw.trim())) {
      const normalised = raw.trim().startsWith('00')
        ? '+' + raw.trim().slice(2)
        : raw.trim()
      const split = splitIntoCountryAndLocal(normalised)
      if (split.country) {
        if (!fixedCountry) setCountry(split.country.iso)
        setLocal(split.local)
        emit(split.local, fixedCountry ?? split.country.iso)
        return
      }
    }
    const digits = raw.replace(/\D/g, '').slice(0, meta.localLength)
    setLocal(digits)
    emit(digits, country)
  }

  function handleCountryChange(next: CountryISO) {
    setCountry(next)
    setDropdownOpen(false)
    emit(local, next)
  }

  const displayValue = formatLocalPhone(local, country)
  const errorText = touched && local.length > 0 && !validation.ok ? validation.error : null

  return (
    <div className={`relative ${wrapperClassName}`} ref={wrapperRef}>
      <div className={`flex items-stretch rounded-xl border border-divider bg-surface-muted overflow-hidden focus-within:border-brand transition-colors ${errorText ? 'border-rose-300' : ''}`}>
        {/* Country selector */}
        <button
          type="button"
          onClick={() => !fixedCountry && !disabled && setDropdownOpen(o => !o)}
          disabled={!!fixedCountry || disabled}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-ink-primary hover:bg-divider/40 disabled:opacity-70 disabled:cursor-not-allowed border-r border-divider flex-shrink-0"
          aria-label={locale === 'fr' ? 'Changer le pays' : 'Change country'}
        >
          <span className="text-base leading-none">{meta.flag}</span>
          <span className="text-sm font-mono">{meta.code}</span>
          {!fixedCountry && (
            <svg className="w-3 h-3 text-ink-tertiary" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          )}
        </button>

        {/* Local number input */}
        <input
          id={id}
          name={name}
          type="tel"
          inputMode="tel"
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
          required={required}
          placeholder={placeholder ?? meta.placeholder}
          value={displayValue}
          onChange={e => handleLocalChange(e.target.value)}
          onBlur={() => setTouched(true)}
          className={`flex-1 bg-transparent px-3 py-2 text-sm text-ink-primary placeholder:text-ink-tertiary focus:outline-none font-mono ${inputClassName}`}
        />
      </div>

      {/* Inline error (opt-in via showError) */}
      {showError && errorText && (
        <p className="mt-1 text-xs text-rose-600">{errorText}</p>
      )}

      {/* Country dropdown */}
      {dropdownOpen && !fixedCountry && (
        <div className="absolute z-50 top-full left-0 mt-1 bg-white rounded-xl shadow-card border border-divider overflow-hidden w-72 max-w-[90vw]">
          {/* Search box — flag/name/dial-code substring match */}
          <div className="p-2 border-b border-divider bg-surface-muted">
            <input
              ref={searchRef}
              type="search"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={locale === 'fr' ? 'Rechercher un pays…' : 'Search countries…'}
              className="w-full bg-white border border-divider rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
            />
          </div>

          {/* Scrollable list — capped so the dropdown doesn't run off
              short viewports. */}
          <div className="max-h-[300px] overflow-y-auto">
            {visibleCountries.length === 0 ? (
              <div className="px-3 py-3 text-sm text-ink-tertiary text-center">
                {locale === 'fr' ? 'Aucun pays trouvé' : 'No countries found'}
              </div>
            ) : (
              visibleCountries.map(c => {
                const active = c.iso === country
                return (
                  <button
                    key={c.iso}
                    type="button"
                    onClick={() => handleCountryChange(c.iso)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors text-left ${
                      active ? 'bg-brand-light text-ink-primary' : 'text-ink-secondary hover:bg-surface-muted'
                    }`}
                  >
                    <span className="text-base leading-none">{c.flag}</span>
                    <span className="font-mono text-xs w-12 flex-shrink-0">{c.code}</span>
                    <span className="flex-1 truncate">{locale === 'fr' ? c.nameFr : c.name}</span>
                    {active && <span className="text-brand">✓</span>}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
