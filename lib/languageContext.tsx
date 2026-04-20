'use client'

import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import dict, { type Locale, type TranslationKey } from './translations'

interface LanguageContextValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: TranslationKey) => string
}

const LanguageContext = createContext<LanguageContextValue>({
  locale: 'fr',
  setLocale: () => {},
  t: (key) => key,
})

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('fr')

  useEffect(() => {
    try {
      const saved = localStorage.getItem('sm_locale') as Locale | null
      if (saved === 'fr' || saved === 'en') setLocaleState(saved)
    } catch {}
  }, [])

  function setLocale(l: Locale) {
    setLocaleState(l)
    try { localStorage.setItem('sm_locale', l) } catch {}
  }

  function t(key: TranslationKey): string {
    return dict[locale][key] ?? key
  }

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  return useContext(LanguageContext)
}

// Bilingual picker. Use `bi(fr, en)` where a string is language-dependent
// but not worth adding to the translations dictionary (one-offs, dynamic
// labels, short phrases). Prefer adding entries to lib/translations.ts +
// t('key') for UI copy that's reused across pages.
export function useBi() {
  const { locale } = useContext(LanguageContext)
  return (fr: string, en: string) => (locale === 'fr' ? fr : en)
}

// Splits a "FR / EN" string at runtime and returns the side that matches
// the current locale. Useful when the bilingual string lives in a
// module-scope map or external data — places `useBi` (a hook) can't reach.
// Strings without " / " pass through unchanged.
export function pickBi(str: string | null | undefined, locale: Locale): string {
  if (!str) return ''
  const i = str.indexOf(' / ')
  if (i === -1) return str
  return locale === 'fr' ? str.slice(0, i) : str.slice(i + 3)
}
