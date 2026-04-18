import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sendWhatsApp } from '@/lib/whatsapp'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH: change role
export async function PATCH(req: NextRequest, { params }: { params: { id: string; memberId: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: ownerEntry } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()
  if (!ownerEntry || ownerEntry.role !== 'owner') {
    return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
  }

  const { role } = await req.json()
  if (!['manager', 'staff'].includes(role)) {
    return NextResponse.json({ error: 'Rôle invalide / Invalid role' }, { status: 400 })
  }

  const { data: before } = await supabaseAdmin
    .from('restaurant_team').select('customer_id, role')
    .eq('id', params.memberId).maybeSingle()

  await supabaseAdmin.from('restaurant_team')
    .update({ role })
    .eq('id', params.memberId)
    .eq('restaurant_id', params.id)

  await writeAudit({
    action: 'team_member_role_changed',
    targetType: 'restaurant_team',
    targetId: params.memberId,
    performedBy: session.id,
    performedByType: 'vendor',
    previousData: before ? { role: before.role, customer_id: before.customer_id } : null,
    metadata: { restaurant_id: params.id, new_role: role },
  })

  return NextResponse.json({ ok: true })
}

// DELETE: remove team member
export async function DELETE(req: NextRequest, { params }: { params: { id: string; memberId: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: ownerEntry } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()
  if (!ownerEntry || ownerEntry.role !== 'owner') {
    return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
  }

  // Get member info before removing
  const { data: entry } = await supabaseAdmin
    .from('restaurant_team')
    .select('customer_id, customers(name, phone)')
    .eq('id', params.memberId).eq('restaurant_id', params.id).maybeSingle()

  await supabaseAdmin.from('restaurant_team')
    .update({ status: 'removed' })
    .eq('id', params.memberId)

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants').select('name').eq('id', params.id).maybeSingle()

  await writeAudit({
    action: 'team_member_removed',
    targetType: 'restaurant_team',
    targetId: params.memberId,
    performedBy: session.id,
    performedByType: 'vendor',
    previousData: entry ? { customer_id: entry.customer_id } : null,
    metadata: { restaurant_id: params.id, restaurant_name: restaurant?.name ?? null },
  })

  // Notify removed member
  if (entry?.customers) {
    const members = entry.customers as unknown as { name: string; phone: string }[]
    const member = Array.isArray(members) ? members[0] : (entry.customers as unknown as { name: string; phone: string })
    await sendWhatsApp(member.phone,
      `👋 Vous avez été retiré de *${restaurant?.name}*.\n` +
      `You have been removed from *${restaurant?.name}*.`)
  }

  return NextResponse.json({ ok: true })
}
