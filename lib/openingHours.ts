// Restaurant open/closed logic + display helpers.
//
// Schedule rows live in restaurant_hours (one per day_of_week). Manual
// override lives on restaurants.manual_override and short-circuits the
// schedule. Times are stored as 'HH:MM' strings (Postgres TIME values
// serialise that way); we compare them lexicographically — same-day
// open_time ≤ now ≤ close_time gives the open window. Overnight hours
// (close_time < open_time) are handled by also peeking at yesterday's
// row to see if that window extends past midnight into today.
//
// All comparisons happen in the restaurant's IANA timezone. We never
// pull the server's clock zone — that's been the source of "open in
// dev, closed in prod" surprises in similar codebases.

export interface RestaurantHourRow {
  day_of_week: number   // 0=Sun…6=Sat (matches Date.getDay())
  open_time:   string   // 'HH:MM' or 'HH:MM:SS' (TIME serialisation)
  close_time:  string
  is_closed:   boolean
}

export interface OpeningLookup {
  manual_override: 'open' | 'closed' | null
  timezone:        string | null
  hours:           RestaurantHourRow[]
}

export interface OpenStatus {
  open:               boolean
  source:             'override' | 'schedule'
  current_day:        number              // 0..6 in restaurant tz
  current_time:       string              // 'HH:MM' in restaurant tz
  next_transition?: {
    kind: 'opens' | 'closes'
    at:   string                          // 'HH:MM' in restaurant tz
    day:  number                          // 0..6 of the transition
  }
}

// ── Timezone-aware "now" ─────────────────────────────────────────────────────
// Returns the day-of-week + HH:MM as observed in the given IANA timezone.
// Pure Intl.DateTimeFormat — no dependency on the runtime's local zone.
const DAY_BY_WEEKDAY: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}
function nowInTimezone(tz: string, at: Date = new Date()): { day: number; hhmm: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  })
  const parts = fmt.formatToParts(at)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Sun'
  // hour: '2-digit' returns '24' for midnight in some node versions; coerce.
  const rawHour = parts.find(p => p.type === 'hour')?.value ?? '00'
  const hour    = rawHour === '24' ? '00' : rawHour
  const minute  = parts.find(p => p.type === 'minute')?.value ?? '00'
  return { day: DAY_BY_WEEKDAY[weekday] ?? 0, hhmm: `${hour}:${minute}` }
}

// ── Time string helpers ──────────────────────────────────────────────────────
function trimSeconds(t: string): string {
  // 'HH:MM:SS' → 'HH:MM'. Postgres TIME serialises with seconds; we don't
  // care about them for opening hours.
  return t.length >= 5 ? t.slice(0, 5) : t
}
function prevDay(d: number): number { return (d + 6) % 7 }

// ── Public: open/closed decision ─────────────────────────────────────────────
export function isRestaurantOpen(lookup: OpeningLookup, at: Date = new Date()): OpenStatus {
  const tz = lookup.timezone || 'Africa/Douala'
  const { day, hhmm } = nowInTimezone(tz, at)

  if (lookup.manual_override === 'open') {
    return { open: true,  source: 'override', current_day: day, current_time: hhmm }
  }
  if (lookup.manual_override === 'closed') {
    return { open: false, source: 'override', current_day: day, current_time: hhmm }
  }

  // Today's row first. Missing row = treated as closed (vendor never set
  // a schedule for that day) — same UX as is_closed=true.
  const todayRow = lookup.hours.find(h => h.day_of_week === day)
  let open = false
  if (todayRow && !todayRow.is_closed) {
    const o = trimSeconds(todayRow.open_time)
    const c = trimSeconds(todayRow.close_time)
    if (o === c) {
      // Degenerate row — treat as closed rather than 24h.
      open = false
    } else if (o < c) {
      open = hhmm >= o && hhmm < c
    } else {
      // Overnight starting today (e.g. 20:00 → 03:00): open from o onward.
      open = hhmm >= o
    }
  }

  // If still closed, check yesterday's overnight row — its window may
  // extend into the small hours of today.
  if (!open) {
    const yRow = lookup.hours.find(h => h.day_of_week === prevDay(day))
    if (yRow && !yRow.is_closed) {
      const yo = trimSeconds(yRow.open_time)
      const yc = trimSeconds(yRow.close_time)
      if (yc < yo) {  // overnight from yesterday
        if (hhmm < yc) open = true
      }
    }
  }

  return {
    open,
    source: 'schedule',
    current_day: day,
    current_time: hhmm,
    next_transition: getNextTransition(lookup, at, { day, hhmm, open }),
  }
}

// Walks forward in time (up to 7 days) to find when the open/closed
// state next flips. Returns undefined if the schedule never opens
// (all days marked closed) — UI just hides the line in that case.
function getNextTransition(
  lookup: OpeningLookup,
  at: Date,
  state: { day: number; hhmm: string; open: boolean },
): OpenStatus['next_transition'] | undefined {
  for (let offset = 0; offset < 8; offset++) {
    const probeDay = (state.day + offset) % 7
    const row = lookup.hours.find(h => h.day_of_week === probeDay)
    if (!row || row.is_closed) continue
    const o = trimSeconds(row.open_time)
    const c = trimSeconds(row.close_time)
    if (state.open) {
      // Looking for close. Today first (must be after now), then future days.
      if (offset === 0) {
        // Match the open() logic exactly: same-day window closes at c when c>o;
        // overnight window closes at c on day+1; yesterday's overnight closes at c today.
        if (o < c && state.hhmm >= o && state.hhmm < c) {
          return { kind: 'closes', at: c, day: probeDay }
        }
        if (o > c && state.hhmm >= o) {
          return { kind: 'closes', at: c, day: (probeDay + 1) % 7 }
        }
        // Could also be currently open via yesterday's overnight row.
        const y = lookup.hours.find(h => h.day_of_week === prevDay(probeDay))
        if (y && !y.is_closed) {
          const yo = trimSeconds(y.open_time); const yc = trimSeconds(y.close_time)
          if (yc < yo && state.hhmm < yc) return { kind: 'closes', at: yc, day: probeDay }
        }
      }
    } else {
      // Looking for next open.
      if (offset === 0) {
        if (state.hhmm < o) return { kind: 'opens', at: o, day: probeDay }
        // Today's open has already passed; keep walking.
        continue
      }
      return { kind: 'opens', at: o, day: probeDay }
    }
  }
  return undefined
}

// ── Schedule display ─────────────────────────────────────────────────────────
// Collapses identical consecutive days into ranges:
//   [Mon 08-22, Tue 08-22, Wed 08-22, Sun closed] → "Mon-Wed: 08:00-22:00, Sun: closed"
// Keeps the order matching the user's start-of-week preference (Mon-Sun).
const DAY_LABEL_FR = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam']
const DAY_LABEL_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEK_ORDER   = [1, 2, 3, 4, 5, 6, 0] // Mon-Sun

export function formatHoursForDisplay(
  hours: RestaurantHourRow[],
  locale: 'fr' | 'en' = 'fr',
): string[] {
  const labels = locale === 'fr' ? DAY_LABEL_FR : DAY_LABEL_EN
  const closedWord = locale === 'fr' ? 'Fermé' : 'Closed'
  const byDay: Record<number, RestaurantHourRow | null> = {}
  for (let d = 0; d < 7; d++) byDay[d] = hours.find(h => h.day_of_week === d) ?? null

  type Group = { days: number[]; label: string }
  const groups: Group[] = []
  for (const d of WEEK_ORDER) {
    const row = byDay[d]
    const label = !row || row.is_closed
      ? closedWord
      : `${trimSeconds(row.open_time)} - ${trimSeconds(row.close_time)}`
    const last = groups[groups.length - 1]
    if (last && last.label === label) {
      last.days.push(d)
    } else {
      groups.push({ days: [d], label })
    }
  }

  return groups.map(g => {
    const range = g.days.length === 1
      ? labels[g.days[0]]
      : `${labels[g.days[0]]}–${labels[g.days[g.days.length - 1]]}`
    return `${range}: ${g.label}`
  })
}

// Single-line summary for the detail-page status banner. Reads better
// in chat-style copy than the full week.
export function nextTransitionLine(
  status: OpenStatus,
  locale: 'fr' | 'en' = 'fr',
): string {
  if (!status.next_transition) {
    return status.open
      ? (locale === 'fr' ? 'Ouvert' : 'Open')
      : (locale === 'fr' ? 'Fermé' : 'Closed')
  }
  const t = status.next_transition
  const dayLabels = locale === 'fr' ? DAY_LABEL_FR : DAY_LABEL_EN
  const sameDay = t.day === status.current_day
  const dayPart = sameDay ? '' : ` ${dayLabels[t.day]}`
  if (t.kind === 'opens') {
    return locale === 'fr' ? `Fermé · ouvre${dayPart} à ${t.at}` : `Closed · opens${dayPart} at ${t.at}`
  }
  return locale === 'fr' ? `Ouvert · ferme${dayPart} à ${t.at}` : `Open · closes${dayPart} at ${t.at}`
}

// City → IANA timezone fallback. Mirrors the migration's UPDATE statements
// so a freshly-inserted restaurant without an explicit tz still routes to
// the right zone via the city field.
export function timezoneForCity(city: string | null | undefined): string {
  const c = (city ?? '').toLowerCase().trim()
  if (c === 'abidjan')                 return 'Africa/Abidjan'
  if (c === 'dakar')                   return 'Africa/Dakar'
  if (c === 'lomé' || c === 'lome')    return 'Africa/Lome'
  return 'Africa/Douala'
}
