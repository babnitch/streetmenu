'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { runClientVersionGuard } from './clientVersion'

// The cities come from the reference data (lib/cities.ts → lib/refData.ts).
import { visibleCities, DEFAULT_CITY, type City } from './cities'
import { useRefData } from './useRefData'
export { visibleCities, type City }

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
  const refVersion = useRefData()

  // Restore the persisted choice on mount. Guarded against malformed
  // localStorage values (e.g. a city that is now hidden) by checking
  // against the offered cities. The version guard runs first; if
  // it detects a stale schema it clears + reloads, and we never reach
  // the read below on the old page instance.
  useEffect(() => {
    runClientVersionGuard()
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored && visibleCities().includes(stored)) setCityState(stored as City)
    } catch {
      /* SSR / private-mode fallback — keep default */
    }
  }, [])

  // The lists refreshed: a selected city that is no longer offered → default.
  useEffect(() => {
    if (refVersion > 0 && !visibleCities().includes(city)) setCityState(DEFAULT_CITY)
  }, [refVersion, city])

  const setCity = (c: City) => {
    setCityState(c)
    try { localStorage.setItem(STORAGE_KEY, c) } catch {}
  }

  return <CityContext.Provider value={{ city, setCity }}>{children}</CityContext.Provider>
}

export function useCity() {
  return useContext(CityContext)
}
