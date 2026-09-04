import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// GET: list team members
//
// Authorization: owner|manager of THIS restaurant, or admin — the shared
// gate in lib/vendorAccess.ts, same as the menu routes. It used to check
// only that SOMEONE was logged in, so any account could pass any
// restaurant id and read that team's names and phone numbers.
//
// Viewing is deliberately one tier looser than managing: POST here and
// PATCH/DELETE in [memberId] are owner-only, because adding and removing
// people is the owner's call, while a manager needs to see who is on the
// roster they work with. Staff and non-members get 403, matching the
// siblings — a logged-in stranger is refused, not told the restaurant
// doesn't exist.
//
// The helper additionally admits the legacy implicit owner (a restaurant
// with customer_id set but no team row — see /api/vendor/restaurants),
// which the owner-only writers here do not. That gap is intentional:
// refusing the real owner sight of their own roster would be a new bug.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied

  // The FK must be named: restaurant_team has TWO foreign keys into
  // customers (customer_id and added_by), so a bare `customers(...)` embed
  // is ambiguous and PostgREST rejects it with PGRST201. Unqualified, this
  // query returned null and the route answered 200 with an empty team.
  const { data: team, error } = await supabaseAdmin
    .from('restaurant_team')
    .select(`id, role, added_at, status, customers!restaurant_team_customer_id_fkey(id, name, phone)`)
    .eq('restaurant_id', params.id)
    .eq('status', 'active')
    .order('added_at')

  if (error) {
    console.error('[restaurants/[id]/team GET] team query failed:', error.code, error.message)
    return NextResponse.json({ error: 'Impossible de charger l\'équipe / Could not load the team' }, { status: 500 })
  }

  // `!fk` is a disambiguation hint, not an alias — the embed still comes
  // back under `customers`, so the client's TeamMember shape is unchanged.
  return NextResponse.json({ team: team ?? [] })
}

// POST: add a team member
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  // Only owner can add team members
  const { data: ownerEntry } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()

  if (!ownerEntry || ownerEntry.role !== 'owner') {
    return NextResponse.json({ error: 'Seul le restaurateur peut gérer l\'équipe / Only the Restaurant Owner can manage the team' }, { status: 403 })
  }

  const { phone, role } = await req.json()
  if (!phone || !['manager', 'staff'].includes(role)) {
    return NextResponse.json({ error: 'Numéro et rôle requis / Phone and role required' }, { status: 400 })
  }

  // Find customer by phone
  const { data: newMember } = await supabaseAdmin
    .from('customers').select('id, name, phone')
    .eq('phone', phone.trim()).eq('status', 'active').maybeSingle()

  if (!newMember) {
    return NextResponse.json({ error: 'Ce numéro n\'est pas inscrit / This number is not registered' }, { status: 404 })
  }

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants').select('name').eq('id', params.id).maybeSingle()

  // Upsert team member
  const { error } = await supabaseAdmin.from('restaurant_team').upsert({
    restaurant_id: params.id,
    customer_id:   newMember.id,
    role,
    added_by:      session.id,
    status:        'active',
  }, { onConflict: 'restaurant_id,customer_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action: 'team_member_added',
    targetType: 'restaurant_team',
    targetId: newMember.id, // the customer id added
    performedBy: session.id,
    performedByType: 'vendor',
    metadata: {
      restaurant_id: params.id,
      restaurant_name: restaurant?.name ?? null,
      role,
      member_name: newMember.name,
      member_phone: newMember.phone,
    },
  })

  // Notify new member
  const lang = await getLangByPhone(newMember.phone)
  await sendWhatsApp(newMember.phone, pickLang(
    `👥 Vous avez été ajouté comme *${role}* chez *${restaurant?.name}* par ${session.name}.`,
    `👥 You've been added as *${role}* at *${restaurant?.name}* by ${session.name}.`,
    lang,
  ), { context: 'team_invitation', relatedId: params.id, customerId: newMember.id })

  return NextResponse.json({ ok: true, member: newMember })
}
