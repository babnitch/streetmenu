import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/like — toggle. Returns { liked, count }.
//
// Idempotent on intent: pressing like when already liked unlikes, pressing
// unlike when not liked is a no-op. Caller doesn't need to know the prior
// state.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  // Verify the event exists + is active. Saves a row insert against a
  // ghost or deleted event.
  const { data: event } = await supabaseAdmin
    .from('events').select('id, is_active').eq('id', params.id).maybeSingle()
  if (!event || !event.is_active) {
    return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  }

  const { data: existing } = await supabaseAdmin
    .from('event_likes')
    .select('id')
    .eq('event_id', params.id)
    .eq('customer_id', session.id)
    .maybeSingle()

  let liked: boolean
  if (existing) {
    await supabaseAdmin.from('event_likes').delete().eq('id', existing.id)
    liked = false
    await writeAudit({
      action: 'event_unliked', targetType: 'event', targetId: params.id,
      performedBy: session.id, performedByType: 'customer',
      metadata: { like_id: existing.id },
    })
  } else {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('event_likes')
      .insert({ event_id: params.id, customer_id: session.id })
      .select('id').single()
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    liked = true
    await writeAudit({
      action: 'event_liked', targetType: 'event', targetId: params.id,
      performedBy: session.id, performedByType: 'customer',
      metadata: { like_id: inserted.id },
    })
  }

  const { count } = await supabaseAdmin
    .from('event_likes')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', params.id)

  return NextResponse.json({ liked, count: count ?? 0 })
}
