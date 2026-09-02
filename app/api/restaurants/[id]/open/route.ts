import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/open
// Body: { is_open: boolean }
//
// The dashboard's open/closed switch. Replaces a browser-side anon-key
// UPDATE of restaurants.is_open that carried no server-side authorization
// at all.
//
// Allowed roles: owner, manager AND staff (plus admins). This deliberately
// diverges from the sibling /override route, which excludes staff: a manual
// schedule override is commercial state, whereas "we're open right now" is
// routine floor operation that whoever is on shift needs to be able to flip.
//
// `is_open` is the ONLY column this route can write. status, is_active,
// approved, deleted_at, suspended_*, commission and every payment field are
// unreachable from here — the update object is built literally, never spread
// from the body.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)
  if (!isAdmin) {
    if (session.role !== 'customer') {
      return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
    }
    // Direct ownership (restaurants.customer_id) OR any active team row.
    // Unlike /override we accept 'staff' here — see the note above.
    const { data: direct } = await supabaseAdmin
      .from('restaurants').select('id')
      .eq('id', params.id).eq('customer_id', session.id).maybeSingle()
    if (!direct) {
      const { data: team } = await supabaseAdmin
        .from('restaurant_team').select('role')
        .eq('restaurant_id', params.id).eq('customer_id', session.id)
        .eq('status', 'active').in('role', ['owner', 'manager', 'staff']).maybeSingle()
      if (!team) return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
    }
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  if (typeof body.is_open !== 'boolean') {
    return NextResponse.json({ error: 'is_open must be boolean' }, { status: 400 })
  }
  const is_open = body.is_open

  const { data, error } = await supabaseAdmin
    .from('restaurants')
    .update({ is_open })
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Restaurant introuvable / Not found' }, { status: 404 })

  await writeAudit({
    action:          'restaurant_open_toggled',
    targetType:      'restaurant',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: isAdmin ? session.role : 'vendor',
    metadata:        { is_open },
  })

  return NextResponse.json({ ok: true, restaurant: data })
}
