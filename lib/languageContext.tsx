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
