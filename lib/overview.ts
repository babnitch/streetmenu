// Pro "Aperçu" figures — pure functions (unit-tested), fed by the overview
// routes. All days and hours are Africa/Douala (UTC+1, no summer time).

export type Period = 'today' | '7d' | '30d'
export const PERIODS: readonly Period[] = ['today', '7d', '30d']

const DOUALA_OFFSET_H = 1

/** First day of the period (YYYY-MM-DD) and the UTC instant it starts. */
export function periodStart(period: Period, today: string): { day: string; iso: string } {
  const back = period === 'today' ? 0 : period === '7d' ? 6 : 29
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - back)
  const day = d.toISOString().slice(0, 10)
  return { day, iso: new Date(Date.parse(`${day}T00:00:00Z`) - DOUALA_OFFSET_H * 3600_000).toISOString() }
}

export function doualaHour(iso: string): number {
  return (new Date(iso).getUTCHours() + DOUALA_OFFSET_H) % 24
}

export interface OrderRow {
  created_at: string; status: string | null; payment_status: string | null; total_price: number | string | null
  refunded_amount?: number | null; fulfilment?: string | null
  items?: Array<{ name?: string; quantity?: number | string }> | null
}

export interface RestaurantFigures {
  orders: number; revenue: number; online: number; onSite: number; average: number
  cancelled: number; delivery: number; pickup: number
  topDishes: Array<{ name: string; quantity: number }>
  hours: Array<{ hour: number; orders: number }>
}

// Orders count once placed; cancelled ones (and fully refunded) are left out
// of orders / revenue and counted apart. Revenue is net of refunds; "online"
// = paid by Mobile Money on the platform, "sur place" = everything else.
export function restaurantFigures(rows: OrderRow[]): RestaurantFigures {
  const out: RestaurantFigures = { orders: 0, revenue: 0, online: 0, onSite: 0, average: 0, cancelled: 0, delivery: 0, pickup: 0, topDishes: [], hours: [] }
  const dishes = new Map<string, number>()
  const hours = new Map<number, number>()
  for (const o of rows) {
    if (o.status === 'cancelled' || o.payment_status === 'refunded') { out.cancelled++; continue }
    const amount = Math.max(0, Math.round(Number(o.total_price ?? 0)) - Math.round(Number(o.refunded_amount ?? 0)))
    out.orders++
    out.revenue += amount
    if (o.payment_status === 'paid') out.online += amount; else out.onSite += amount
    if (o.fulfilment === 'delivery') out.delivery++; else out.pickup++
    for (const it of o.items ?? []) {
      const name = String(it?.name ?? '').trim()
      if (name) dishes.set(name, (dishes.get(name) ?? 0) + (Number(it.quantity) || 1))
    }
    const h = doualaHour(o.created_at)
    hours.set(h, (hours.get(h) ?? 0) + 1)
  }
  out.average = out.orders ? Math.round(out.revenue / out.orders) : 0
  out.topDishes = Array.from(dishes, ([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)).slice(0, 5)
  out.hours = Array.from(hours, ([hour, orders]) => ({ hour, orders })).sort((a, b) => b.orders - a.orders || a.hour - b.hour)
  return out
}

export interface StatRow { metric: string; count: number }
export function sumStats(rows: StatRow[]): { views: number; clicks: Record<string, number> } {
  const clicks: Record<string, number> = {}
  let views = 0
  for (const r of rows) {
    if (r.metric === 'view') views += r.count
    else if (r.metric.startsWith('click_')) clicks[r.metric] = (clicks[r.metric] ?? 0) + r.count
  }
  return { views, clicks }
}
