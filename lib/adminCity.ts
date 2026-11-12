'use client'

// One city filter for the admin pages (Restaurants, Événements, À visiter,
// Commandes, Comptes, À la une, Statistiques): « Toutes » or one of the
// visible reference cities. The choice is remembered in this browser
// (falls back to « Toutes » when storage is blocked or the city is no longer
// offered) and shown in the tab title, e.g. « Restaurants · Douala ».
// The pages pass it to their API as ?city= (lib/adminCityServer.ts).

import { useEffect, useState } from 'react'
import { useRefData } from '@/lib/useRefData'
import { visibleCities } from '@/lib/cities'

const KEY = 'tn_admin_city'

export function useAdminCity(title: string): { city: string; setCity: (c: string) => void; ready: boolean; cities: string[] } {
  useRefData()
  // null until the browser storage has been read (no fetch before that).
  const [raw, setRaw] = useState<string | null>(null)
  useEffect(() => {
    let v = ''
    try { v = localStorage.getItem(KEY) ?? '' } catch { /* blocked: Toutes */ }
    setRaw(v)
  }, [])
  const cities = visibleCities()
  const city = raw && cities.includes(raw) ? raw : ''
  useEffect(() => { document.title = city ? `${title} · ${city}` : title }, [title, city])
  function setCity(c: string) {
    setRaw(c)
    try { if (c) localStorage.setItem(KEY, c); else localStorage.removeItem(KEY) } catch { /* not remembered */ }
  }
  return { city, setCity, ready: raw !== null, cities }
}

/** "city=Douala" for a query string, "" for Toutes. */
export const cityQuery = (city: string): string => (city ? `city=${encodeURIComponent(city)}` : '')
