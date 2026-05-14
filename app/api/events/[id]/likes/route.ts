import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/events/[id]/likes → { count, userLiked }
// Public count + a userLiked flag when the caller is signed in. Used by
// the detail page on mount to render the heart in its current state.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { count } = await supabaseAdmin
    .from('event_likes')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', params.id)

  let userLiked = false
  const session = getSessionFromRequest(req)
  if (session?.role === 'customer') {
    const { data } = await supabaseAdmin
      .from('event_likes')
      .select('id')
      .eq('event_id', params.id)
      .eq('customer_id', session.id)
      .maybeSingle()
    userLiked = !!data
  }

  return NextResponse.json({ count: count ?? 0, userLiked })
}
