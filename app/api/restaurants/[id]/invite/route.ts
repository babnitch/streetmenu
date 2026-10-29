import { NextRequest, NextResponse } from 'next/server'
import { requireRestaurantModule } from '@/lib/modulesServer'
import { inviteTeamMember } from '@/lib/teamInvite'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { normalizePhone } from '@/lib/phone'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/invite
//
// Owner-only team invitation. Mirrors the WhatsApp "ajouter +XXX role" flow:
//
//   - If the phone is already an active customer → insert a restaurant_team
//     row immediately (same as POST /team) and fire the welcome WhatsApp.
//   - If the phone isn't a customer yet → write a pending row into
//     team_invitations and fire an invitation WhatsApp with accept/decline
//     instructions. The invitee replies on WhatsApp to finish the flow.
//
// A pending invitation to the same (restaurant, phone) is rejected up-front
// so owners don't spam the same invitee. Owners can cancel via the dashboard
// or WhatsApp "annuler invitation +XXX" before re-inviting.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: ownerEntry } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()

  if (!ownerEntry || ownerEntry.role !== 'owner') {
    return NextResponse.json({ error: 'Seul le restaurateur peut inviter / Only the Restaurant Owner can invite' }, { status: 403 })
  }

  // M3: inviting needs the Équipe module.
  const teamOff = await requireRestaurantModule(params.id, 'team')
  if (teamOff) return teamOff

  const body = await req.json().catch(() => ({}))
  const phone = normalizePhone(body.phone)
  const role  = body.role as string
  if (!phone || !['manager', 'staff'].includes(role)) {
    return NextResponse.json({ error: 'Numéro et rôle requis / Phone and role required' }, { status: 400 })
  }

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants').select('id, name').eq('id', params.id).maybeSingle()
  if (!restaurant) {
    return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
  }

  const r = await inviteTeamMember(restaurant, phone, role as 'manager' | 'staff', {
    customerId: session.id, name: session.name, actorId: session.id, actorType: 'vendor', via: 'invite-endpoint',
  })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json(r)
}

// GET /api/restaurants/[id]/invite — list pending invitations. Owner only.
// Expired rows aren't filtered here — they're returned so the UI can render
// "expired" badges instead of silently vanishing.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: ownerEntry } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()

  if (!ownerEntry || ownerEntry.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data } = await supabaseAdmin
    .from('team_invitations')
    .select('id, phone, role, status, created_at, expires_at')
    .eq('restaurant_id', params.id)
    .in('status', ['pending'])
    .order('created_at', { ascending: false })

  return NextResponse.json({ invitations: data ?? [] })
}
