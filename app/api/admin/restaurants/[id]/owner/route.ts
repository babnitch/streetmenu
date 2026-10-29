import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { normalizePhone } from '@/lib/phone'
import { sanitizeText, sanitizePhone } from '@/lib/sanitize'
import { findOrCreateAccount } from '@/lib/ownerAccount'
import { toggleModule } from '@/lib/modules'
import { setRestaurantModules } from '@/lib/modulesServer'
import { orderContactCount } from '@/lib/managedRestaurant'

export const dynamic = 'force-dynamic'

// /api/admin/restaurants/[id]/owner (N3)
//
// POST   { phone, name?, old_owner: 'remove' | 'manager' }  — change the owner.
//        The account behind the phone is reused or created (name required
//        for a new number). The admin chooses what happens to the old owner
//        each time: removed from the team, or kept as manager. The
//        restaurant stops being "managed by Tchop & Ndjoka". Nobody is
//        messaged: the welcome goes out only with POST …/welcome.
// DELETE { old_owner: 'remove' | 'manager' }                — remove the
//        owner: back to managed. If that leaves no order contact, Commandes
//        (and what needs it) is switched off.
// Audited (owner_changed / owner_removed). Admin-only (super_admin | admin).

type OldOwner = 'remove' | 'manager'

function oldOwnerChoice(raw: unknown): OldOwner | null {
  return raw === 'remove' || raw === 'manager' ? raw : null
}

async function currentOwners(restaurantId: string): Promise<Array<{ id: string; customer_id: string }>> {
  const { data } = await supabaseAdmin.from('restaurant_team')
    .select('id, customer_id').eq('restaurant_id', restaurantId).eq('role', 'owner').eq('status', 'active')
  return (data ?? []) as Array<{ id: string; customer_id: string }>
}

async function demote(rows: Array<{ id: string }>, choice: OldOwner) {
  if (rows.length === 0) return
  await supabaseAdmin.from('restaurant_team')
    .update(choice === 'remove' ? { status: 'removed' } : { role: 'manager' })
    .in('id', rows.map(r => r.id))
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const phone = normalizePhone(sanitizePhone(body.phone))
  const name = sanitizeText(body.name, 60)

  const { data: rest } = await supabaseAdmin.from('restaurants')
    .select('id, name, city, customer_id, managed_by_platform, deleted_at').eq('id', params.id).maybeSingle()
  if (!rest || rest.deleted_at) return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })

  const owners = await currentOwners(rest.id)
  const choice = oldOwnerChoice(body.old_owner)
  if (owners.length > 0 && !choice) {
    return NextResponse.json({ error: 'Choisissez : retirer l\'ancien propriétaire ou le garder comme gérant / Choose: remove the old owner or keep them as manager', field: 'old_owner' }, { status: 400 })
  }

  const acc = await findOrCreateAccount(phone, name, rest.city, { id: session.id, type: session.role }, 'restaurant_owner_change')
  if (!acc.ok) return NextResponse.json({ error: acc.error, field: acc.field }, { status: acc.status })
  const next = acc.account
  if (owners.some(o => o.customer_id === next.id)) {
    return NextResponse.json({ error: 'C\'est déjà le propriétaire / Already the owner', field: 'owner_phone' }, { status: 409 })
  }

  await demote(owners, choice ?? 'remove')
  const { error: teamErr } = await supabaseAdmin.from('restaurant_team').upsert(
    { restaurant_id: rest.id, customer_id: next.id, role: 'owner', status: 'active', added_by: null },
    { onConflict: 'restaurant_id,customer_id' },
  )
  if (teamErr) return NextResponse.json({ error: teamErr.message }, { status: 500 })
  const { error } = await supabaseAdmin.from('restaurants')
    .update({ customer_id: next.id, owner_name: next.name, managed_by_platform: false })
    .eq('id', rest.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action: 'owner_changed', targetType: 'restaurant', targetId: rest.id,
    performedBy: session.id, performedByType: session.role,
    previousData: { owner_ids: owners.map(o => o.customer_id), managed: rest.managed_by_platform === true },
    metadata: { new_owner_id: next.id, new_owner_phone: next.phone, account_created: acc.created, old_owner: owners.length ? choice : null },
  })
  return NextResponse.json({ ok: true, owner: { customer_id: next.id, name: next.name, phone: next.phone }, created: acc.created })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const choice = oldOwnerChoice(body.old_owner)
  if (!choice) {
    return NextResponse.json({ error: 'Choisissez : retirer ou garder comme gérant / Choose: remove or keep as manager', field: 'old_owner' }, { status: 400 })
  }
  const { data: rest } = await supabaseAdmin.from('restaurants')
    .select('id, modules, deleted_at').eq('id', params.id).maybeSingle()
  if (!rest || rest.deleted_at) return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
  const owners = await currentOwners(rest.id)
  if (owners.length === 0) return NextResponse.json({ error: 'Pas de propriétaire / No owner' }, { status: 409 })

  await demote(owners, choice)
  const { error } = await supabaseAdmin.from('restaurants')
    .update({ customer_id: null, owner_name: null, managed_by_platform: true })
    .eq('id', rest.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Nobody left to receive orders → back to Vitrine.
  const modules = (rest.modules as string[] | null) ?? []
  let ordersSwitchedOff = false
  if (modules.includes('orders') && (await orderContactCount(rest.id)) === 0) {
    const set = await setRestaurantModules(rest.id, toggleModule('restaurant', modules, 'orders', false),
      { id: session.id, type: session.role }, 'owner_removed')
    ordersSwitchedOff = set.ok
  }

  await writeAudit({
    action: 'owner_removed', targetType: 'restaurant', targetId: rest.id,
    performedBy: session.id, performedByType: session.role,
    previousData: { owner_ids: owners.map(o => o.customer_id) },
    metadata: { old_owner: choice, orders_switched_off: ordersSwitchedOff },
  })
  return NextResponse.json({ ok: true, managed: true, orders_switched_off: ordersSwitchedOff })
}
