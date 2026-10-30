// The app's cities — from the reference data (lib/refData.ts: Admin →
// Données de référence, backup list when the database can't be read).
// Pickers, menus and forms offer the VISIBLE cities; a hidden city's
// existing restaurants / events / places keep it (isCity accepts it).

import { refList, refFind, refKnown, refOffered } from './refData'

export type City = string
export const DEFAULT_CITY: City = 'Yaoundé'

/** Offered cities (picker, bot menu, forms), in display order. */
export const visibleCities = (): string[] => refList('city').map(c => c.code)
/** Every known city, hidden ones too (admin filters, validation of reads). */
export const allCities = (): string[] => refList('city', { includeHidden: true }).map(c => c.code)

/** Known city (visible or hidden). */
export const isCity = (v: unknown): v is City => refKnown('city', v)
/** A city a form may submit (visible). */
export const isOfferedCity = (v: unknown): v is City => refOffered('city', v)

/** Centre and zoom (map start, a new restaurant's pin). */
export function cityCentre(city: string | null | undefined): { lat: number; lng: number; zoom: number } | null {
  const c = refFind('city', city)
  return c && c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng, zoom: c.zoom ?? 13 } : null
}

// Test runs (scripts/testkit) put their restaurants and events in a made-up
// per-run city, "__t_<run>_city__", so they never show in a real city's
// lists. The city-scoped public APIs accept such a city ONLY on the test
// server (TEST_ONLY_PHONE_PREFIX set) — in production it stays a 400.
export function isTestCity(v: unknown): boolean {
  return typeof v === 'string' && /^__t_[0-9a-z]+_city__$/i.test(v)
}
export function isServedCity(v: unknown): boolean {
  return isCity(v) || (!!process.env.TEST_ONLY_PHONE_PREFIX && isTestCity(v))
}
