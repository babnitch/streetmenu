import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sendWhatsApp } from '@/lib/whatsapp'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const { reason } = await req.json()
  const restaurantId = params.id

  // Fetch restaurant
  const { data: restaurant } = await supabaseAdmin
    .from('restaurants').select('id, name, whatsapp, customer_id, status, deleted_at')
    .eq('id', restaurantId).maybeSingle()

  if (!restaurant) return NextResponse.json({ error: 'Restaurant introuvable / Not found' }, { status: 404 })
  if (restaurant.deleted_at) return NextResponse.json({ error: 'Restaurant supprimé / Already deleted' }, { status: 400 })

  let suspendedBy: string

  if (session.role === 'customer') {
    // Vendor can only suspend their own restaurant
    const { data: teamEntry } = await supabaseAdmin
      .from('restaurant_team').select('role')
      .eq('restaurant_id', restaurantId).eq('customer_id', session.id).eq('status', 'active').maybeSingle()
    if (!teamEntry || teamEntry.role !== 'owner') {
      return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
    }
    suspendedBy = 'vendor'
  } else if (['super_admin', 'admin'].includes(session.role)) {
    suspendedBy = 'admin'
  } else {
    return NextResponse.json({ error: 'Permission insuffisante / Insufficient permission' }, { status: 403 })
  }

  await supabaseAdmin.from('restaurants').update({
    status: 'suspended',
    suspended_at: new Date().toISOString(),
    suspended_by: suspendedBy,
    suspension_reason: reason ?? null,
  }).eq('id', restaurantId)

  await writeAudit({
    action: 'restaurant_suspended',
    targetType: 'restaurant',
    targetId: restaurantId,
    performedBy: session.id,
    performedByType: session.role,
    previousData: { status: restaurant.status, name: restaurant.name },
    metadata: { suspendedBy, reason: reason ?? null },
  })

  // Notify vendor via WhatsApp
  if (restaurant.whatsapp) {
    if (suspendedBy === 'vendor') {
      await sendWhatsApp(restaurant.whatsapp,
        `⏸️ *${restaurant.name}* est suspendu.\n` +
        `Envoyez "reactiver" pour le réactiver.\n\n` +
        `*${restaurant.name}* is suspended.\n` +
        `Send "reactiver" to reactivate.`)
    } else {
      await sendWhatsApp(restaurant.whatsapp,
        `⛔ *${restaurant.name}* a été suspendu par l'administration.\n` +
        `Contactez le support pour plus d'informations.\n\n` +
        `*${restaurant.name}* has been suspended by admin.\n` +
        `Contact support for more information.`)
    }
  }

  return NextResponse.json({ ok: true })
}
