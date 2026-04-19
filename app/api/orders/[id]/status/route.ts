import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import {
  notifyCustomerOrderConfirmed,
  notifyCustomerOrderPreparing,
  notifyCustomerOrderReady,
  notifyCustomerOrderDelivered,
  notifyCustomerOrderCancelled,
} from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

type VendorStatus = 'confirmed' | 'preparing' | 'ready' | 'delivered' | 'cancelled'

// Roles allowed to apply each status transition.
// Spec: owner + manager → full power; staff → ready + delivered only.
const ROLE_MATRIX: Record<VendorStatus, Array<'owner' | 'manager' | 'staff'>> = {
  confirmed: ['owner', 'manager'],
  preparing: ['owner', 'manager'],
  ready:     ['owner', 'manager', 'staff'],
  delivered: ['owner', 'manager', 'staff'],
  cancelled: ['owner', 'manager'],
}

// Allowed "from" statuses for each target. Guards against out-of-order
// transitions (e.g. moving a delivered order back to preparing).
const FROM_MATRIX: Record<VendorStatus, string[]> = {
  confirmed: ['pending'],
  preparing: ['pending', 'confirmed'],
  ready:     ['pending', 'confirmed', 'preparing'],
  delivered: ['ready', 'completed'],            // completed is legacy but ready→delivered is the canonical path
  cancelled: ['pending', 'confirmed', 'preparing', 'ready'],
}

function isVendorStatus(s: unknown): s is VendorStatus {
  return typeof s === 'string' && (['confirmed', 'preparing', 'ready', 'delivered', 'cancelled'] as const).includes(s as VendorStatus)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const targetStatus = body?.status
  if (!isVendorStatus(targetStatus)) {
    return NextResponse.json({ error: 'Statut invalide / Invalid status' }, { status: 400 })
  }

  // Load the order to know the restaurant and prior status
  const { data: order, error: orderErr } = await supabaseAdmin
    .from('orders')
    .select('id, status, restaurant_id, customer_name, customer_phone, items, total_price, created_at')
    .eq('id', params.id)
    .maybeSingle()

  if (orderErr || !order) {
    return NextResponse.json({ error: 'Commande introuvable / Order not found' }, { status: 404 })
  }

  // Resolve the role this session has for that restaurant.
  // Admins bypass the team check — they manage every restaurant.
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)
  let effectiveRole: 'owner' | 'manager' | 'staff' | 'admin' | null = null

  if (isAdmin) {
    effectiveRole = 'admin'
  } else {
    const { data: team } = await supabaseAdmin
      .from('restaurant_team')
      .select('role')
      .eq('restaurant_id', order.restaurant_id)
      .eq('customer_id', session.id)
      .eq('status', 'active')
      .maybeSingle()
    if (team?.role && ['owner', 'manager', 'staff'].includes(team.role)) {
      effectiveRole = team.role as 'owner' | 'manager' | 'staff'
    }
  }

  if (!effectiveRole) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  if (effectiveRole !== 'admin' && !ROLE_MATRIX[targetStatus].includes(effectiveRole)) {
    return NextResponse.json({
      error: `Rôle ${effectiveRole} ne peut pas appliquer ce statut / Role ${effectiveRole} cannot apply this status`,
    }, { status: 403 })
  }

  if (!FROM_MATRIX[targetStatus].includes(order.status)) {
    return NextResponse.json({
      error: `Transition invalide: ${order.status} → ${targetStatus} / Invalid transition`,
    }, { status: 409 })
  }

  // Apply the update
  const { error: updErr } = await supabaseAdmin
    .from('orders')
    .update({ status: targetStatus, updated_at: new Date().toISOString() })
    .eq('id', params.id)

  if (updErr) {
    console.error('[order-status] update failed:', updErr.message)
    // 'delivered' against the pre-migration constraint fails with a CHECK
    // violation — surface that as something the user can act on.
    const hint = /orders_status_chk|check constraint/i.test(updErr.message)
      ? ' (migration supabase-orders-delivered-status.sql may not be applied)'
      : ''
    return NextResponse.json({ error: updErr.message + hint }, { status: 500 })
  }

  await writeAudit({
    action: `order_${targetStatus}`,
    targetType: 'order',
    targetId: order.id,
    performedBy: session.id,
    performedByType: effectiveRole === 'admin' ? session.role : 'vendor',
    previousData: { status: order.status, role: effectiveRole },
  })

  // Customer notification. Awaited (not fire-and-forget) so Vercel can't
  // kill the Twilio fetch mid-flight. Failure is logged, not thrown.
  const { data: rest } = await supabaseAdmin
    .from('restaurants').select('name').eq('id', order.restaurant_id).maybeSingle()
  const restaurantName = rest?.name ?? '—'

  const payload = {
    id: order.id,
    customer_name: order.customer_name,
    customer_phone: order.customer_phone,
    items: (order.items as Array<{ name: string; quantity: number; price: number }>) ?? [],
    total_price: Number(order.total_price),
    created_at: order.created_at,
  }

  let customerNotified = false
  if (order.customer_phone) {
    try {
      switch (targetStatus) {
        case 'confirmed': await notifyCustomerOrderConfirmed(order.customer_phone, payload, restaurantName); break
        case 'preparing': await notifyCustomerOrderPreparing(order.customer_phone, payload, restaurantName); break
        case 'ready':     await notifyCustomerOrderReady    (order.customer_phone, payload, restaurantName); break
        case 'delivered': await notifyCustomerOrderDelivered(order.customer_phone, payload, restaurantName); break
        case 'cancelled': await notifyCustomerOrderCancelled(order.customer_phone, payload, restaurantName); break
      }
      customerNotified = true
    } catch (e) {
      console.error(`[order-status] whatsapp notify failed for ${targetStatus}:`, (e as Error).message)
    }
  }

  return NextResponse.json({
    ok: true,
    status: targetStatus,
    previousStatus: order.status,
    customerNotified,
  })
}
