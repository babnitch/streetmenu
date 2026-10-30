'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { runClientVersionGuard } from './clientVersion'

// The cities live in lib/cities.ts (one list, also used server-side);
// re-exported here for the components that already import them from here.
import { CITIES, DEFAULT_CITY, type City } from './cities'
export { CITIES, type City }

interface CityContextValue {
  city: City
  setCity: (c: City) => void
}

const STORAGE_KEY = 'tn_selected_city'

const CityContext = createContext<CityContextValue>({
  city: DEFAULT_CITY,
  setCity: () => {},
})

export function CityProvider({ children }: { children: ReactNode }) {
  const [city, setCityState] = useState<City>(DEFAULT_CITY)

  // Restore the persisted choice on mount. Guarded against malformed
  // localStorage values (e.g. a city name we removed later) by checking
  // against the canonical CITIES list. The version guard runs first; if
  // it detects a stale schema it clears + reloads, and we never reach
  // the read below on the old page instance.
  useEffect(() => {
    runClientVersionGuard()
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored && (CITIES as readonly string[]).includes(stored)) {
        setCityState(stored as City)
      }
    } catch {
      /* SSR / private-mode fallback — keep default */
    }
  }, [])

  const setCity = (c: City) => {
    setCityState(c)
    try { localStorage.setItem(STORAGE_KEY, c) } catch {}
  }

  return <CityContext.Provider value={{ city, setCity }}>{children}</CityContext.Provider>
}

export function useCity() {
  return useContext(CityContext)
}
