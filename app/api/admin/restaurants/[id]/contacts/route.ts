import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { normalizePhone } from '@/lib/phone'
import { inviteTeamMember } from '@/lib/teamInvite'
import { orderContactCount, orderPhones, LAST_CONTACT_TEXT } from '@/lib/managedRestaurant'

export const dynamic = 'force-dynamic'

// /api/admin/restaurants/[id]/contacts (N3) — who receives a restaurant's
// orders and who is on its team, managed from the admin restaurant card.
//
// GET  → { restaurant, owner, team, invitations, order_phones }
// POST { action, … }
//   add_order_phone    { phone }          a WhatsApp number that gets orders
//   remove_order_phone { phone }
//   invite_member      { phone, role }    manager | staff, the normal
//                                         invitation flow (WhatsApp)
//   remove_member      { customer_id }    manager / staff only (the owner
//                                         changes through /owner)
//   cancel_invitation  { id }
// A managed restaurant taking orders keeps at least one order contact: the
// last one can't be removed while Commandes is on.
// Admin-only (super_admin | admin), service role.

type Session = NonNullable<ReturnType<typeof getSessionFromRequest>>

function authorize(req: NextRequest): Session | null {
  const s = getSessionFromRequest(req)
  return s && ['super_admin', 'admin'].includes(s.role) ? s : null
}

async function loadRestaurant(id: string) {
  const { data } = await supabaseAdmin.from('restaurants')
    .select('id, name, city, whatsapp, customer_id, managed_by_platform, modules, deleted_at')
    .eq('id', id).maybeSingle()
  return data
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!authorize(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const restaurant = await loadRestaurant(params.id)
  if (!restaurant) return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })

  const [{ data: team }, { data: invitations }, phones] = await Promise.all([
    supabaseAdmin.from('restaurant_team')
      .select('customer_id, role, added_at, customers!restaurant_team_customer_id_fkey(id, name, phone)')
      .eq('restaurant_id', params.id).eq('status', 'active'),
    supabaseAdmin.from('team_invitations')
      .select('id, phone, role, expires_at, created_at')
      .eq('restaurant_id', params.id).eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }),
    orderPhones(params.id),
  ])
  const members = ((team ?? []) as unknown as Array<{ customer_id: string; role: string; customers: { id: string; name: string; phone: string } | null }>)
    .map(m => ({ customer_id: m.customer_id, role: m.role, name: m.customers?.name ?? '', phone: m.customers?.phone ?? '' }))
  const owner = members.find(m => m.role === 'owner') ?? null

  return NextResponse.json({
    restaurant: {
      id: restaurant.id, name: restaurant.name, managed: restaurant.managed_by_platform === true,
      whatsapp: restaurant.whatsapp, takes_orders: ((restaurant.modules as string[] | null) ?? []).includes('orders'),
    },
    owner,
    team: members.filter(m => m.role !== 'owner'),
    invitations: invitations ?? [],
    order_phones: phones,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = authorize(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const restaurant = await loadRestaurant(params.id)
  if (!restaurant || restaurant.deleted_at) return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const action = String(body.action ?? '')
  const audit = (a: string, metadata: Record<string, unknown>) => writeAudit({
    action: a, targetType: 'restaurant', targetId: restaurant.id,
    performedBy: session.id, performedByType: session.role, metadata,
  })
  // The last order contact of a managed restaurant taking orders stays.
  const guardLastContact = async (): Promise<NextResponse | null> => {
    const takesOrders = ((restaurant.modules as string[] | null) ?? []).includes('orders')
    if (restaurant.managed_by_platform === true && takesOrders && (await orderContactCount(restaurant.id)) <= 1) {
      return NextResponse.json({ error: LAST_CONTACT_TEXT, reason: 'last_contact' }, { status: 409 })
    }
    return null
  }

  if (action === 'add_order_phone' || action === 'remove_order_phone') {
    const phone = normalizePhone(typeof body.phone === 'string' ? body.phone : '')
    if (!/^\+\d{8,15}$/.test(phone)) {
      return NextResponse.json({ error: 'Numéro invalide / Invalid number', field: 'phone' }, { status: 400 })
    }
    if (action === 'add_order_phone') {
      const { error } = await supabaseAdmin.from('restaurant_order_phones')
        .upsert({ restaurant_id: restaurant.id, phone }, { onConflict: 'restaurant_id,phone', ignoreDuplicates: true })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      await audit('order_phone_added', { phone })
    } else {
      const blocked = await guardLastContact()
      if (blocked) return blocked
      await supabaseAdmin.from('restaurant_order_phones').delete().eq('restaurant_id', restaurant.id).eq('phone', phone)
      await audit('order_phone_removed', { phone })
    }
    return NextResponse.json({ ok: true, order_phones: await orderPhones(restaurant.id) })
  }

  if (action === 'invite_member') {
    const phone = normalizePhone(typeof body.phone === 'string' ? body.phone : '')
    const role = body.role
    if (!/^\+\d{8,15}$/.test(phone) || (role !== 'manager' && role !== 'staff')) {
      return NextResponse.json({ error: 'Numéro et rôle requis / Phone and role required' }, { status: 400 })
    }
    const r = await inviteTeamMember({ id: restaurant.id, name: restaurant.name }, phone, role, {
      customerId: null, name: 'Tchop & Ndjoka', actorId: session.id, actorType: session.role, via: 'admin-card',
    })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json(r)
  }

  if (action === 'remove_member') {
    const customerId = String(body.customer_id ?? '')
    const { data: row } = await supabaseAdmin.from('restaurant_team')
      .select('id, role').eq('restaurant_id', restaurant.id).eq('customer_id', customerId).eq('status', 'active').maybeSingle()
    if (!row) return NextResponse.json({ error: 'Membre introuvable / Member not found' }, { status: 404 })
    if (row.role === 'owner') {
      return NextResponse.json({ error: 'Le propriétaire se change avec « Changer le propriétaire » / Use "Change owner" for the owner' }, { status: 400 })
    }
    const blocked = await guardLastContact()
    if (blocked) return blocked
    await supabaseAdmin.from('restaurant_team').update({ status: 'removed' }).eq('id', row.id)
    await audit('team_member_removed_by_admin', { customer_id: customerId, role: row.role })
    return NextResponse.json({ ok: true })
  }

  if (action === 'cancel_invitation') {
    const id = String(body.id ?? '')
    const { data: inv } = await supabaseAdmin.from('team_invitations')
      .update({ status: 'cancelled' }).eq('id', id).eq('restaurant_id', restaurant.id).eq('status', 'pending')
      .select('id, phone').maybeSingle()
    if (!inv) return NextResponse.json({ error: 'Invitation introuvable / Invitation not found' }, { status: 404 })
    await audit('team_invitation_cancelled', { invitation_id: id, phone: inv.phone })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Action inconnue / Unknown action' }, { status: 400 })
}
