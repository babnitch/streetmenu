import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { parseTrack, isBot } from '@/lib/stats'
import { CITIES } from '@/lib/cities'
import { todayInDouala } from '@/lib/weekend'
import { rateLimit, clientIP } from '@/lib/rateLimit'

export const dynamic = 'force-dynamic'

// POST /api/track — one anonymous count (sendBeacon from lib/track.ts).
// Body: { m: metric, t?: item type, i?: item id, c?: city, q?: search words }
// Stored: +1 on (day in Africa/Douala, city, item, metric). No cookie, no IP,
// no user id is stored — the IP is only used, in memory, to cap floods.
// Bots are ignored. Always answers 204 (a beacon never waits).
export async function POST(req: NextRequest) {
  const done = new NextResponse(null, { status: 204 })
  if (isBot(req.headers.get('user-agent'))) return done
  if (rateLimit({ key: `track:${clientIP(req)}`, max: 120, windowMs: 60_000 })) return done
  let body: unknown = null
  try { body = JSON.parse(await req.text()) } catch { return done }
  const t = parseTrack(body, CITIES)
  if (!t) return done
  const { error } = await supabaseAdmin.rpc('stats_bump', {
    p_day: todayInDouala(), p_city: t.city, p_type: t.type, p_id: t.id, p_metric: t.metric, p_n: 1,
  })
  if (error) console.error('[track] bump failed:', error.message)
  return done
}
