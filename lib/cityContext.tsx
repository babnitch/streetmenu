'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

// The four supported cities. Kept here so TopNav's dropdown and the home
// page's filter never drift — import `CITIES` wherever the list is needed.
// If you add another city, update this array + the Mapbox center coords
// in app/page.tsx alongside it.
export const CITIES = ['Yaoundé', 'Abidjan', 'Dakar', 'Lomé'] as const
export type City = (typeof CITIES)[number]

interface CityContextValue {
  city: City
  setCity: (c: City) => void
}

const STORAGE_KEY = 'nt_selected_city'
const DEFAULT_CITY: City = 'Yaoundé'

const CityContext = createContext<CityContextValue>({
  city: DEFAULT_CITY,
  setCity: () => {},
})

export function CityProvider({ children }: { children: ReactNode }) {
  const [city, setCityState] = useState<City>(DEFAULT_CITY)

  // Restore the persisted choice on mount. Guarded against malformed
  // localStorage values (e.g. a city name we removed later) by checking
  // against the canonical CITIES list.
  useEffect(() => {
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
