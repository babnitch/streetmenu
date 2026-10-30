'use client'

// Browser side of the reference data (lib/refData.ts). Pages first render
// with the current lists (the backup on a first visit — identical to the
// server render, so no hydration mismatch), then this provider loads
// /api/ref (a local copy is reused for 60 s) and re-renders whatever uses
// useRefData(): pickers, filters, forms, labels.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { setRefValues, type RefValue } from './refData'

const KEY = 'tn_ref_v1'
const TTL_MS = 60_000
const RefDataContext = createContext(0)

export function RefDataProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    let fresh = false
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) {
        const c = JSON.parse(raw) as { at: number; values: RefValue[] }
        if (Array.isArray(c.values) && c.values.length) { setRefValues(c.values); setVersion(n => n + 1) }
        fresh = Date.now() - c.at < TTL_MS
      }
    } catch { /* no storage */ }
    if (!fresh) {
      fetch('/api/ref').then(r => r.ok ? r.json() : null).then(d => {
        if (!live || !Array.isArray(d?.values) || !d.values.length) return
        setRefValues(d.values)
        try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), values: d.values })) } catch { /* full */ }
        setVersion(n => n + 1)
      }).catch(() => null)
    }
    return () => { live = false }
  }, [])
  return <RefDataContext.Provider value={version}>{children}</RefDataContext.Provider>
}

/** Re-render when the lists change. Call it in any component that shows a
 *  list or a label from the reference data. */
export function useRefData(): number {
  return useContext(RefDataContext)
}
