import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sendWhatsApp } from '@/lib/whatsapp'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const restaurantId = params.id

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants').select('id, name, whatsapp, customer_id, status, suspended_by, deleted_at')
    .eq('id', restaurantId).maybeSingle()

  if (!restaurant) return NextResponse.json({ error: 'Restaurant introuvable / Not found' }, { status: 404 })
  if (restaurant.deleted_at) return NextResponse.json({ error: 'Restaurant supprimé / Already deleted' }, { status: 400 })
  if (restaurant.status !== 'suspended') return NextResponse.json({ error: 'Pas suspendu / Not suspended' }, { status: 400 })

  if (session.role === 'customer') {
    const { data: teamEntry } = await supabaseAdmin
      .from('restaurant_team').select('role')
      .eq('restaurant_id', restaurantId).eq('customer_id', session.id).eq('status', 'active').maybeSingle()
    if (!teamEntry || teamEntry.role !== 'owner') {
      return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
    }
    // Vendor can only reactivate if they suspended it themselves
    if (restaurant.suspended_by !== 'vendor') {
      return NextResponse.json({ error: 'Vous ne pouvez pas réactiver ce restaurant. Contactez le support. / You cannot reactivate this restaurant. Contact support.' }, { status: 403 })
    }
  } else if (!['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Permission insuffisante / Insufficient permission' }, { status: 403 })
  }

  await supabaseAdmin.from('restaurants').update({
    status: 'active',
    suspended_at: null,
    suspended_by: null,
    suspension_reason: null,
  }).eq('id', restaurantId)

  await writeAudit({
    action: 'restaurant_reactivated',
    targetType: 'restaurant',
    targetId: restaurantId,
    performedBy: session.id,
    performedByType: session.role,
    previousData: { suspended_by: restaurant.suspended_by, name: restaurant.name },
  })

  if (restaurant.whatsapp) {
    await sendWhatsApp(restaurant.whatsapp,
      `✅ *${restaurant.name}* est maintenant actif!\n` +
      `*${restaurant.name}* is now active!`)
  }

  return NextResponse.json({ ok: true })
}
