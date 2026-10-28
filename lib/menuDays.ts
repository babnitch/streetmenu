// Menu par jour (D1). Pure and client-safe: the dashboard, the restaurant
// page, the bot and the server pricing share one copy of the rules.
//
// restaurants.menu_type: 'a_la_carte' (default — every dish every day,
// nothing changes) or 'daily'. In 'daily', menu_items.available_days says
// which days a dish is served: 0 = Sunday … 6 = Saturday (same numbering as
// restaurant_hours). "Today" is the restaurant's own day (its timezone, else
// its city's, else Africa/Douala) — like the offers.

import { restaurantZone } from '@/lib/offers'

export type MenuType = 'a_la_carte' | 'daily'
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const
// Monday first, as a week is read in Cameroon and in the dashboard.
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

const NAMES = {
  fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
}
const SHORT = {
  fr: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
}

export function dayName(d: number, locale: 'fr' | 'en'): string { return NAMES[locale][d] ?? '' }
export function dayShort(d: number, locale: 'fr' | 'en'): string { return SHORT[locale][d] ?? '' }

export function isDailyMenu(r: { menu_type?: string | null } | null | undefined): boolean {
  return r?.menu_type === 'daily'
}

// 0–6 as the calendar reads in that zone.
export function weekdayInZone(tz: string, at: Date = new Date()): number {
  let wd = 'Sun'
  try {
    wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(at)
  } catch {
    wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Douala', weekday: 'short' }).format(at)
  }
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
}

export function restaurantWeekday(r: { timezone?: string | null; city?: string | null }, at: Date = new Date()): number {
  return weekdayInZone(restaurantZone(r), at)
}

// The days a dish is served (all days when unset or À la carte).
export function servedDays(item: { available_days?: number[] | null }, menuType?: string | null): number[] {
  if (menuType !== 'daily') return [...ALL_DAYS]
  const d = item.available_days
  return Array.isArray(d) && d.length > 0 ? d : [...ALL_DAYS]
}

export function isServedOn(item: { available_days?: number[] | null }, day: number, menuType?: string | null): boolean {
  return servedDays(item, menuType).includes(day)
}

// "le samedi" · "le samedi et le dimanche" · "lun., mer. et ven." (FR)
// "on Saturday" · "on Saturday and Sunday" · "Mon, Wed and Fri" (EN)
export function daysLabel(days: number[], locale: 'fr' | 'en'): string {
  const sorted = WEEK_ORDER.filter(d => days.includes(d))
  const and = locale === 'fr' ? ' et ' : ' and '
  if (sorted.length === 0) return ''
  if (sorted.length <= 2) {
    const names = sorted.map(d => locale === 'fr' ? `le ${dayName(d, 'fr')}` : dayName(d, 'en'))
    return (locale === 'en' ? 'on ' : '') + names.join(and)
  }
  const short = sorted.map(d => dayShort(d, locale))
  return short.slice(0, -1).join(', ') + and + short[short.length - 1]
}

// "Disponible le samedi" / "Available on Saturday"
export function availableOnText(days: number[], locale: 'fr' | 'en'): string {
  const l = daysLabel(days, locale)
  return locale === 'fr' ? `Disponible ${l}` : `Available ${l}`
}

export type DaysValidation = { ok: true; days: number[] } | { ok: false; error: string }

export function validateDays(raw: unknown): DaysValidation {
  if (!Array.isArray(raw)) return { ok: false, error: 'Jours invalides / Invalid days' }
  const set = new Set<number>()
  for (const x of raw) {
    const n = Number(x)
    if (!Number.isInteger(n) || n < 0 || n > 6) return { ok: false, error: 'Jours invalides / Invalid days' }
    set.add(n)
  }
  if (set.size === 0) return { ok: false, error: 'Choisissez au moins un jour / Pick at least one day' }
  return { ok: true, days: [...ALL_DAYS].filter(d => set.has(d)) }
}

export function validateMenuType(raw: unknown): MenuType | null {
  return raw === 'daily' ? 'daily' : raw === 'a_la_carte' ? 'a_la_carte' : null
}
