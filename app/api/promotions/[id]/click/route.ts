import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'

// POST /api/promotions/[id]/click
// Fired by the PromotedCard click handler before the Link navigation.
// Increments promotions.clicks for the targeted row.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const { data: row } = await supabaseAdmin
    .from('promotions')
    .select('clicks, status')
    .eq('id', params.id)
    .maybeSingle()
  if (!row || row.status !== 'active') {
    return NextResponse.json({ ok: false })
  }
  await supabaseAdmin
    .from('promotions')
    .update({ clicks: (row.clicks ?? 0) + 1 })
    .eq('id', params.id)
  return NextResponse.json({ ok: true })
}
