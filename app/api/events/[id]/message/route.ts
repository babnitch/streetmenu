import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sendEventMessage } from '@/lib/directMessaging'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/message
// Body: { message: string }
// Organizer (organizer_id === session.id) or admin only. Sends a free-text
// message over WhatsApp to everyone with an active reservation for this event.
// Free + targeted — distinct from the paid city-wide broadcast. Rate-limited
// to 2 per event per day. Returns { sent_count }.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const body = await req.json().catch(() => ({}))
  const message = typeof body?.message === 'string' ? body.message : ''
  if (!message.trim()) {
    return NextResponse.json({ error: 'Message vide / Empty message' }, { status: 400 })
  }
  if (message.trim().length > 1000) {
    return NextResponse.json({ error: 'Message trop long (max 1000) / Message too long (max 1000)' }, { status: 400 })
  }

  const { data: event } = await supabaseAdmin
    .from('events')
    .select('id, organizer_id, organizer_name, title, date, time, venue')
    .eq('id', params.id)
    .maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (!isAdmin && event.organizer_id !== session.id) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const result = await sendEventMessage(event, message, session.id, session.role)
  if (!result.ok) {
    if (result.rate_limited) {
      return NextResponse.json(
        { error: 'Limite atteinte (2 messages/jour) / Daily limit reached (2 messages/day)' },
        { status: 429 },
      )
    }
    return NextResponse.json({ error: 'Erreur / Error' }, { status: 400 })
  }
  return NextResponse.json({ sent_count: result.sent_count })
}
