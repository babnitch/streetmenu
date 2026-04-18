import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sendWhatsApp } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

// GET: list team members
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const { data: team } = await supabaseAdmin
    .from('restaurant_team')
    .select('id, role, added_at, status, customers(id, name, phone)')
    .eq('restaurant_id', params.id)
    .eq('status', 'active')
    .order('added_at')

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
    return NextResponse.json({ error: 'Seul le propriétaire peut gérer l\'équipe / Only owner can manage team' }, { status: 403 })
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

  // Notify new member
  await sendWhatsApp(newMember.phone,
    `👥 Vous avez été ajouté comme *${role}* chez *${restaurant?.name}* par ${session.name}.\n` +
    `You've been added as *${role}* at *${restaurant?.name}* by ${session.name}.`)

  return NextResponse.json({ ok: true, member: newMember })
}
