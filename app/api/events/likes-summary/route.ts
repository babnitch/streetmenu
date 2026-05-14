import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'

// GET /api/events/likes-summary?ids=a,b,c
// Bulk endpoint for the events list. Returns counts keyed by event id.
// Events with zero likes are absent from the map so the card stays clean.
export async function GET(req: NextRequest) {
  const idsParam = req.nextUrl.searchParams.get('ids') ?? ''
  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 200)
  if (ids.length === 0) return NextResponse.json({ summary: {} })

  const { data } = await supabaseAdmin
    .from('event_likes')
    .select('event_id')
    .in('event_id', ids)

  const summary: Record<string, number> = {}
  for (const r of data ?? []) summary[r.event_id] = (summary[r.event_id] ?? 0) + 1
  return NextResponse.json({ summary })
}
