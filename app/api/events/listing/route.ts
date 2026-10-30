import { NextRequest, NextResponse } from 'next/server'
import { getRefData } from '@/lib/refDataServer'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getEventAvailability } from '@/lib/eventSeats'
import { getActivePromotions } from '@/lib/promotions'
import { EVENT_DATE_COLUMNS, isPastEvent, todayISO } from '@/lib/eventDate'
import { isServedCity } from '@/lib/cities'
import { fromPrice, pickFeatured, type ListingDay } from '@/lib/eventStatus'

export const dynamic = 'force-dynamic'

// GET /api/events/listing?city=Yaoundé — everything the Events page (Sortir)
// needs in one call (E1):
//   events[]   every upcoming event of the city: poster, place, its upcoming
//              days with seats left and the cheapest price still on sale
//              that day, "Dès X FCFA", seats booked in the last 7 days
//              (for "Beaucoup de réservations");
//   featuredId "À la une": admin pick → paid promotion → most bookings;
//   promoted   active paid promotions (for "Sponsorisé" + click tracking).
// Public: only what the event pages already show — no names or phones.
// Seats come from the per-day capacity functions (one call per event).
export async function GET(req: NextRequest) {
  await getRefData()
  const city = req.nextUrl.searchParams.get('city') ?? ''
  if (!isServedCity(city)) {
    return NextResponse.json({ error: 'city' }, { status: 400 })
  }
  const today = todayISO()
  const nowIso = new Date().toISOString()

  const { data: rows, error } = await supabaseAdmin
    .from('events')
    .select(`id, title, category, venue, neighborhood, city, cover_photo, organizer_name, description, is_featured, ticket_price, price, booking_mode, event_status, reservations_open, ${EVENT_DATE_COLUMNS}`)
    .eq('city', city).eq('is_active', true)
    .order('date', { ascending: true })
  if (error) {
    console.error('[events/listing] events read failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  const events = ((rows ?? []) as unknown as Array<Record<string, unknown> & { id: string }>)
    .filter(e => e.event_status !== 'cancelled' && !isPastEvent(e as never))
  const ids = events.map(e => e.id)

  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const since7  = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [tierRes, resvRes, promos] = await Promise.all([
    ids.length
      ? supabaseAdmin.from('event_ticket_tiers').select('id, event_id, price, sales_start, sales_end')
          .in('event_id', ids).eq('is_active', true)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ids.length
      ? supabaseAdmin.from('event_reservations').select('event_id, quantity, created_at')
          .in('event_id', ids).gte('created_at', since30)
          .not('reservation_status', 'in', '(cancelled,rejected)').range(0, 9999)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    getActivePromotions({ city, targetType: 'event' }).catch(() => []),
  ])

  // Tiers on sale now, per event.
  const tiersBy: Record<string, Array<{ id: string; price: number }>> = {}
  for (const t of (tierRes.data ?? []) as Array<{ id: string; event_id: string; price: number; sales_start: string | null; sales_end: string | null }>) {
    if (t.sales_start && t.sales_start > nowIso) continue
    if (t.sales_end && t.sales_end < nowIso) continue
    ;(tiersBy[t.event_id] ??= []).push({ id: t.id, price: Number(t.price ?? 0) })
  }
  const seats30: Record<string, number> = {}, seats7: Record<string, number> = {}
  for (const r of (resvRes.data ?? []) as Array<{ event_id: string; quantity: number; created_at: string }>) {
    seats30[r.event_id] = (seats30[r.event_id] ?? 0) + Number(r.quantity ?? 1)
    if (r.created_at >= since7) seats7[r.event_id] = (seats7[r.event_id] ?? 0) + Number(r.quantity ?? 1)
  }

  const out = await Promise.all(events.map(async e => {
    const av = (await getEventAvailability(e.id, today)) ?? []
    const tiers = tiersBy[e.id] ?? []
    const single = Number(e.ticket_price ?? e.price ?? 0) || 0
    // I6: an info-only event with no price given shows no price (not "Gratuit").
    const priceUnknown = e.booking_mode === 'info' && e.ticket_price == null && e.price == null
    const days: ListingDay[] = av.filter(d => !d.past).map(d => {
      let minPrice: number | null
      if (tiers.length) {
        const open = tiers.filter(t => !d.tiers.find(x => x.tier_id === t.id)?.soldOut)
        minPrice = open.length ? Math.min(...open.map(t => t.price)) : null
      } else {
        minPrice = d.soldOut || priceUnknown ? null : single
      }
      return { date: d.date, capacity: d.capacity, sold: d.sold, remaining: d.remaining, soldOut: d.soldOut, minPrice }
    })
    return {
      id: e.id, title: e.title, category: e.category, venue: e.venue, neighborhood: e.neighborhood,
      cover_photo: e.cover_photo, organizer_name: e.organizer_name,
      // For the Loisirs search (artists are usually named here); trimmed.
      description: typeof e.description === 'string' ? e.description.slice(0, 400) : null,
      date: e.date, time: e.time, end_date: e.end_date, end_time: e.end_time,
      reservations_open: e.reservations_open !== false,
      days,
      fromPrice: fromPrice(days),
      recentSeats7d: seats7[e.id] ?? 0,
      is_featured: !!e.is_featured,
    }
  }))
  // Events with no upcoming day left (e.g. availability failed) still list,
  // with their dates; the page shows no status for them.

  const promoted = (promos as Array<{ id: string; target_id: string; placement: string }>)
    .filter(p => ids.includes(p.target_id))
    .map(p => ({ promotion_id: p.id, event_id: p.target_id, placement: p.placement }))
  const featuredId = pickFeatured(
    out.map(e => ({ id: e.id, is_featured: e.is_featured, firstDay: e.days[0]?.date ?? (e.date as string), bookings30d: seats30[e.id] ?? 0 })),
    promoted.filter(p => p.placement === 'top_list').map(p => p.event_id),
  )

  return NextResponse.json({ today, featuredId, promoted, events: out }, { headers: { 'Cache-Control': 'no-store' } })
}
