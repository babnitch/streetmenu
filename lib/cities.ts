// The app's cities — the ONE list (city picker, restaurants, Loisirs, Lieux,
// home rows, profile, sign-ups, subscriptions, broadcasts). Pure data, no
// React, so server routes and client components share it. Order = the
// picker's order. D1: Douala.

export const CITIES = ['Yaoundé', 'Douala', 'Abidjan', 'Dakar', 'Lomé'] as const
export type City = (typeof CITIES)[number]
export const DEFAULT_CITY: City = 'Yaoundé'

// Centre (a new restaurant's pin until placed; the map's start) and zoom.
export const CITY_CENTRES: Record<City, { lat: number; lng: number; zoom: number }> = {
  'Yaoundé': { lat: 3.848,   lng: 11.5021,  zoom: 13 },
  'Douala':  { lat: 4.0511,  lng: 9.7679,   zoom: 13 },
  'Abidjan': { lat: 5.36,    lng: -4.0083,  zoom: 13 },
  'Dakar':   { lat: 14.6937, lng: -17.4441, zoom: 13 },
  'Lomé':    { lat: 6.1375,  lng: 1.2123,   zoom: 13 },
}

export function isCity(v: unknown): v is City {
  return typeof v === 'string' && (CITIES as readonly string[]).includes(v)
}
