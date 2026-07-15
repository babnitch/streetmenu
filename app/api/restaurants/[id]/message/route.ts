import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sendRestaurantMessage, type RestaurantAudience } from '@/lib/directMessaging'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/message
// Body: { message: string, target: 'active' | 'recent_7days' }
// Owner/manager (or admin) only. Sends a free-text WhatsApp message to the
// restaurant's customers — those with active orders, or any order in the last
// 7 days. Free + targeted. Rate-limited to 1 per restaurant per day.
// Returns { sent_count }.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const body = await req.json().catch(() => ({}))
  const message = typeof body?.message === 'string' ? body.message : ''
  const target: RestaurantAudience = body?.target === 'recent_7days' ? 'recent_7days' : 'active'
  if (!message.trim()) {
    return NextResponse.json({ error: 'Message vide / Empty message' }, { status: 400 })
  }
  if (message.trim().length > 1000) {
    return NextResponse.json({ error: 'Message trop long (max 1000) / Message too long (max 1000)' }, { status: 400 })
  }

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants').select('id, name, deleted_at').eq('id', params.id).maybeSingle()
  if (!restaurant || restaurant.deleted_at) {
    return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
  }

  // Owner or manager may message customers (staff cannot). Admins bypass.
  if (!isAdmin) {
    const { data: member } = await supabaseAdmin
      .from('restaurant_team').select('role')
      .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()
    if (!member || !['owner', 'manager'].includes(member.role)) {
      return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }
  }

  const result = await sendRestaurantMessage(restaurant, message, target, session.id, session.role)
  if (!result.ok) {
    if (result.rate_limited) {
      return NextResponse.json(
        { error: 'Limite atteinte (1 message/jour) / Daily limit reached (1 message/day)' },
        { status: 429 },
      )
    }
    return NextResponse.json({ error: 'Erreur / Error' }, { status: 400 })
  }
  return NextResponse.json({ sent_count: result.sent_count })
}
