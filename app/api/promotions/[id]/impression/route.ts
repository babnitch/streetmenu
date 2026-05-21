import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { rateLimit, clientIP } from '@/lib/rateLimit'

export const dynamic = 'force-dynamic'

// POST /api/promotions/[id]/impression
// Fire-and-forget bump of promotions.impressions. Caller is the
// PromotedCard component when its IntersectionObserver fires.
//
// Client-side dedupe (sessionStorage with 1-hour TTL) keeps page
// refreshes from flooding the counter. Server adds a per-IP cap on
// top so a scripted scroll-bot can't inflate impressions arbitrarily.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const limited = rateLimit({ key: `impression:${clientIP(req)}`, max: 60, windowMs: 60_000 })
  if (limited) return NextResponse.json({ ok: false, throttled: true }, { status: 429 })
  const { data: row } = await supabaseAdmin
    .from('promotions')
    .select('impressions, status')
    .eq('id', params.id)
    .maybeSingle()
  if (!row || row.status !== 'active') {
    return NextResponse.json({ ok: false })
  }
  await supabaseAdmin
    .from('promotions')
    .update({ impressions: (row.impressions ?? 0) + 1 })
    .eq('id', params.id)
  return NextResponse.json({ ok: true })
}
