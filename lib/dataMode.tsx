'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

// Low-data mode — when ON, image-heavy surfaces drop to text + gradient
// placeholders. Cuts data usage by an order of magnitude on cards-heavy
// pages (home, events list). Stored in localStorage so the choice
// survives reloads; we don't (yet) sync it to the customer profile.

const STORAGE_KEY = 'tn_low_data'

interface DataModeValue {
  isLowData: boolean
  setLowData: (v: boolean) => void
  toggle:    () => void
}

const DataModeContext = createContext<DataModeValue>({
  isLowData: false,
  setLowData: () => {},
  toggle: () => {},
})

export function DataModeProvider({ children }: { children: ReactNode }) {
  const [isLowData, setState] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === '1') setState(true)
    } catch { /* private mode — keep default */ }
  }, [])

  function setLowData(v: boolean) {
    setState(v)
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0') } catch {}
  }

  function toggle() { setLowData(!isLowData) }

  return (
    <DataModeContext.Provider value={{ isLowData, setLowData, toggle }}>
      {children}
    </DataModeContext.Provider>
  )
}

export function useDataMode() {
  return useContext(DataModeContext)
}
