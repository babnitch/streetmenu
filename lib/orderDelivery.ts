// Order hand-over / delivery confirmation (Q2). Server-only.
//
// One function marks an order delivered, whoever confirms it — the record
// Prompt P will release held money from:
//   delivered_confirmed_by  customer | rider | restaurant_scan |
//                           restaurant_code | restaurant_manual | auto
//   delivered_actor_id/type who pressed it; delivered_by_rider (Q5).
// Atomic: the update only applies while the order is still open, so two
// confirmations at once can't both succeed.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { getLangByPhone, notifyCustomerOrderDelivered, notifyCustomerOutForDelivery, sendWhatsApp, pickLang } from '@/lib/whatsapp'
import { vendorRecipients } from '@/lib/whatsapp/ordering'
import { orderCode } from '@/lib/shortCode'
import { afterHandover } from '@/lib/protectedPayments'

export type DeliveredBy = 'customer' | 'rider' | 'restaurant_scan' | 'restaurant_code' | 'restaurant_manual' | 'auto'
export interface DeliveryActor { id: string | null; type: 'customer' | 'admin' }

// Statuses an order can be handed over / delivered from (not pending: the
// restaurant hasn't accepted it; not cancelled).
export const HANDOVER_FROM = ['confirmed', 'preparing', 'ready', 'out_for_delivery'] as const

export const ORDER_COLUMNS = 'id, status, restaurant_id, customer_id, customer_name, customer_phone, items, total_price, created_at, order_type, payment_status, fulfilment, delivered_at, delivered_confirmed_by, delivered_actor_id, delivered_actor_type, rider_id'

export type OrderRow = {
  id: string; status: string; restaurant_id: string; customer_id: string | null; customer_name: string | null
  customer_phone: string | null; items: unknown; total_price: number; created_at: string; order_type: string | null
  payment_status: string | null; fulfilment: string | null; delivered_at: string | null
  delivered_confirmed_by: string | null; delivered_actor_id: string | null; delivered_actor_type: string | null
  rider_id: string | null
}

// Why an order can't be handed over now, FR / EN, or null.
export function handoverRefusal(o: Pick<OrderRow, 'status' | 'order_type' | 'payment_status'>): string | null {
  if (o.status === 'cancelled') return 'Commande annulée / Order cancelled'
  if (o.status === 'pending') return 'Commande pas encore acceptée par le restaurant / Order not accepted by the restaurant yet'
  if (o.order_type === 'paid_order' && o.payment_status !== 'paid') return 'Paiement en ligne non confirmé / Online payment not confirmed'
  return null
}

export function isHandedOver(o: Pick<OrderRow, 'status'>): boolean {
  return o.status === 'delivered' || o.status === 'completed'
}

export type MarkResult =
  | { ok: true; order: OrderRow }
  | { ok: false; reason: 'not_found' | 'already' | 'refused'; error: string; order?: OrderRow }

export async function markOrderDelivered(
  orderId: string, by: DeliveredBy, actor: DeliveryActor | null,
  opts: { riderId?: string | null; notify?: 'customer' | 'restaurant' | 'none'; skipFunds?: boolean } = {},
): Promise<MarkResult> {
  const { data: before } = await supabaseAdmin.from('orders').select(ORDER_COLUMNS).eq('id', orderId).maybeSingle()
  if (!before) return { ok: false, reason: 'not_found', error: 'Commande introuvable / Order not found' }
  const o = before as OrderRow
  if (isHandedOver(o)) return { ok: false, reason: 'already', error: 'Déjà remise / Already handed over', order: o }
  const refusal = handoverRefusal(o)
  if (refusal) return { ok: false, reason: 'refused', error: refusal, order: o }

  const now = new Date().toISOString()
  const { data: rows } = await supabaseAdmin.from('orders')
    .update({
      status: 'delivered', delivered_at: now, updated_at: now,
      delivered_confirmed_by: by,
      delivered_actor_id: actor?.id ?? null, delivered_actor_type: actor?.type ?? null,
      ...(opts.riderId ? { delivered_by_rider: opts.riderId } : {}),
    })
    .eq('id', orderId).in('status', [...HANDOVER_FROM])
    .select(ORDER_COLUMNS)
  const after = (rows?.[0] ?? null) as OrderRow | null
  if (!after) {
    const { data: again } = await supabaseAdmin.from('orders').select(ORDER_COLUMNS).eq('id', orderId).maybeSingle()
    return { ok: false, reason: 'already', error: 'Déjà remise / Already handed over', order: (again ?? o) as OrderRow }
  }

  await writeAudit({
    action: 'order_delivered', targetType: 'order', targetId: orderId,
    performedBy: actor?.id ?? null, performedByType: actor?.type === 'admin' ? 'admin' : (by === 'customer' ? 'customer' : 'vendor'),
    previousData: { status: o.status }, metadata: { delivered_confirmed_by: by, rider_id: opts.riderId ?? null },
  })

  const notify = opts.notify ?? 'customer'
  try {
    const { data: rest } = await supabaseAdmin.from('restaurants').select('name').eq('id', after.restaurant_id).maybeSingle()
    const name = (rest?.name as string | undefined) ?? ''
    if (notify === 'customer' && after.customer_phone) {
      const payload = { id: after.id, customer_name: after.customer_name ?? '', customer_phone: after.customer_phone, items: after.items as never, total_price: Number(after.total_price), created_at: after.created_at, fulfilment: after.fulfilment }
      await notifyCustomerOrderDelivered(after.customer_phone, payload, name, await getLangByPhone(after.customer_phone))
    }
    if (notify === 'restaurant') {
      for (const p of await vendorRecipients(after.restaurant_id)) {
        await sendWhatsApp(p, pickLang(
          `✅ Commande #${orderCode(after.id)} reçue par le client.`,
          `✅ Order #${orderCode(after.id)} received by the customer.`, await getLangByPhone(p)),
          { context: 'order_status_update', relatedId: after.id })
      }
    }
  } catch (e) {
    console.error('[orderDelivery] notify failed:', (e as Error).message)
  }
  // Protected payment: released now (rider with the code, customer "Reçu"),
  // or the customer is told and it is released later (lib/protectedPayments).
  if (!opts.skipFunds) await afterHandover(after.id, by, actor)
  return { ok: true, order: after }
}

// "En livraison": a delivery order leaves the restaurant (ready, or
// earlier). The customer gets the delivery code.
export async function markOutForDelivery(orderId: string, actor: DeliveryActor | null): Promise<MarkResult> {
  const { data: before } = await supabaseAdmin.from('orders').select(ORDER_COLUMNS).eq('id', orderId).maybeSingle()
  if (!before) return { ok: false, reason: 'not_found', error: 'Commande introuvable / Order not found' }
  const o = before as OrderRow
  if (o.fulfilment !== 'delivery') return { ok: false, reason: 'refused', error: 'Commande à emporter / Take-away order', order: o }
  const refusal = handoverRefusal(o)
  if (refusal) return { ok: false, reason: 'refused', error: refusal, order: o }
  const now = new Date().toISOString()
  const { data: rows } = await supabaseAdmin.from('orders')
    .update({ status: 'out_for_delivery', out_for_delivery_at: now, updated_at: now })
    .eq('id', orderId).in('status', ['confirmed', 'preparing', 'ready'])
    .select(ORDER_COLUMNS)
  const after = (rows?.[0] ?? null) as OrderRow | null
  if (!after) return { ok: false, reason: 'already', error: 'Déjà en livraison ou livrée / Already out for delivery or delivered', order: o }
  await writeAudit({
    action: 'order_out_for_delivery', targetType: 'order', targetId: orderId,
    performedBy: actor?.id ?? null, performedByType: actor?.type === 'admin' ? 'admin' : 'vendor',
    previousData: { status: o.status },
  })
  if (after.customer_phone) {
    const { data: rest } = await supabaseAdmin.from('restaurants').select('name').eq('id', after.restaurant_id).maybeSingle()
    const payload = { id: after.id, customer_name: after.customer_name ?? '', customer_phone: after.customer_phone, items: after.items as never, total_price: Number(after.total_price), created_at: after.created_at, fulfilment: after.fulfilment }
    await notifyCustomerOutForDelivery(after.customer_phone, payload, (rest?.name as string | undefined) ?? '', await getLangByPhone(after.customer_phone))
      .catch(e => console.error('[orderDelivery] out-for-delivery notify:', (e as Error).message))
  }
  return { ok: true, order: after }
}
