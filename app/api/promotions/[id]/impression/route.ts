import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'

// POST /api/promotions/[id]/impression
// Fire-and-forget bump of promotions.impressions. Caller is the
// PromotedCard component when its IntersectionObserver fires.
//
// Client-side dedupe (sessionStorage with 1-hour TTL) keeps page
// refreshes from flooding the counter; server adds no dedupe beyond
// the requirement that the promotion still exists.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
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
