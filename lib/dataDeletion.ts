// Data deletion requests and account anonymisation (U2). Server-only.
//
// A request comes from /suppression-donnees (web form) or WhatsApp
// ("supprimer" / "supprimer mes données"), or is added by an admin. The admin
// then anonymises the account:
//   - customers: status 'deleted', name "Compte supprimé", phone replaced by
//     a placeholder (it can no longer log in), nickname / pro name / extra
//     numbers cleared
//   - orders and bookings KEEP amounts, items and payment records (needed for
//     accounting); the name, phone and delivery address/landmark/phone on
//     them are removed
//   - team / door-staff / rider roles ended; message history (WhatsApp/SMS
//     bodies), login codes and sessions deleted
// Refused while the account owns a restaurant (change the owner first) or
// organises an upcoming event. Audited without personal data.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { normalizePhone } from '@/lib/phone'
import { isPastEvent, EVENT_DATE_COLUMNS } from '@/lib/eventDate'

export const DELETED_NAME = 'Compte supprimé'
export const DELETED_CUSTOMER_NAME = 'Client supprimé'

export function maskPhone(phone: string): string {
  const p = phone.replace(/[^\d+]/g, '')
  return p.length > 4 ? `${p.slice(0, 4)}…${p.slice(-2)}` : '…'
}

async function customerByPhone(phone: string): Promise<{ id: string } | null> {
  const p = normalizePhone(phone)
  if (!p) return null
  const { data } = await supabaseAdmin.from('customers').select('id').in('phone', [p, p.replace(/^\+/, '')]).limit(1)
  return (data?.[0] as { id: string } | undefined) ?? null
}

export async function createDeletionRequest(phoneRaw: string, reason: string | null, via: 'web' | 'whatsapp'): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const phone = normalizePhone(phoneRaw)
  if (!/^\+\d{8,15}$/.test(phone)) return { ok: false, error: 'Numéro invalide / Invalid number' }
  // One open request per number is enough.
  const { data: open } = await supabaseAdmin.from('data_deletion_requests').select('id')
    .eq('phone', phone).eq('status', 'pending').limit(1).maybeSingle()
  if (open) return { ok: true, id: open.id as string }
  const c = await customerByPhone(phone)
  const { data, error } = await supabaseAdmin.from('data_deletion_requests')
    .insert({ phone, reason: reason?.slice(0, 500) || null, customer_id: c?.id ?? null, via })
    .select('id').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Erreur / Error' }
  await writeAudit({
    action: 'data_deletion_requested', targetType: 'customer', targetId: c?.id ?? data.id as string,
    performedBy: c?.id ?? null, performedByType: 'customer', metadata: { request_id: data.id, via },
  })
  return { ok: true, id: data.id as string }
}

export type AnonymiseResult = { ok: true; counts: Record<string, number> } | { ok: false; status: number; error: string }

export async function anonymiseAccount(requestId: string, actor: { id: string; type: string }): Promise<AnonymiseResult> {
  const { data: req } = await supabaseAdmin.from('data_deletion_requests').select('*').eq('id', requestId).maybeSingle()
  if (!req) return { ok: false, status: 404, error: 'Demande introuvable / Request not found' }
  if (req.status !== 'pending') return { ok: false, status: 409, error: 'Demande déjà traitée / Request already handled' }
  const phone = req.phone as string
  const cust = (req.customer_id ? { id: req.customer_id as string } : null) ?? await customerByPhone(phone)
  const counts: Record<string, number> = {}

  if (cust) {
    const { count: owns } = await supabaseAdmin.from('restaurant_team').select('id', { count: 'exact', head: true })
      .eq('customer_id', cust.id).eq('role', 'owner').eq('status', 'active')
    if ((owns ?? 0) > 0) return { ok: false, status: 409, error: 'Ce compte possède un restaurant : changez d\'abord le propriétaire / This account owns a restaurant: change the owner first' }
    // Upcoming = not over yet (multi-day events count until their last day).
    const { data: evs } = await supabaseAdmin.from('events').select(`id, ${EVENT_DATE_COLUMNS}`)
      .eq('organizer_id', cust.id).eq('is_active', true)
    if ((evs ?? []).some(e => !isPastEvent(e as never))) return { ok: false, status: 409, error: 'Ce compte organise un événement à venir / This account organises an upcoming event' }
  }

  const phones = [phone, phone.replace(/^\+/, '')]
  const n = async (p: PromiseLike<{ count: number | null }>) => (await p).count ?? 0

  // Orders and bookings: keep the money, drop who.
  const orderFilter = cust ? `customer_id.eq.${cust.id},customer_phone.in.(${phones.join(',')})` : `customer_phone.in.(${phones.join(',')})`
  counts.orders = await n(supabaseAdmin.from('orders').update({
    customer_name: DELETED_CUSTOMER_NAME, customer_phone: '', delivery_phone: null, delivery_landmark: null, manual_payment_phone: null,
  }, { count: 'exact' }).or(orderFilter))
  await supabaseAdmin.from('orders').update({ delivery_address: '—' }).or(orderFilter).eq('fulfilment', 'delivery')
  counts.bookings = await n(supabaseAdmin.from('event_reservations').update({
    customer_name: DELETED_CUSTOMER_NAME, customer_phone: '',
  }, { count: 'exact' }).or(cust ? `customer_id.eq.${cust.id},customer_phone.in.(${phones.join(',')})` : `customer_phone.in.(${phones.join(',')})`))

  // Messages, login codes, sessions.
  for (const p of phones) {
    counts.messages = (counts.messages ?? 0) + await n(supabaseAdmin.from('message_log').delete({ count: 'exact' }).like('to_number', `%${p.replace(/^\+/, '')}`))
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', p)
    await supabaseAdmin.from('verification_codes').delete().eq('phone', p)
  }

  if (cust) {
    await supabaseAdmin.from('restaurant_team').update({ status: 'removed' }).eq('customer_id', cust.id)
    await supabaseAdmin.from('event_door_staff').update({ status: 'removed' }).eq('customer_id', cust.id)
    await supabaseAdmin.from('restaurant_riders').update({ status: 'removed' }).eq('customer_id', cust.id)
    const { error } = await supabaseAdmin.from('customers').update({
      name: DELETED_NAME, phone: `deleted:${cust.id}`, status: 'deleted', deleted_at: new Date().toISOString(),
      nickname: null, pro_name: null, pro_notify_phone: null, momo_phone: null,
    }).eq('id', cust.id)
    if (error) return { ok: false, status: 500, error: error.message }
    counts.account = 1
  }

  await supabaseAdmin.from('data_deletion_requests').update({
    status: 'done', handled_by: actor.id, handled_at: new Date().toISOString(), phone: maskPhone(phone),
  }).eq('id', requestId)
  await writeAudit({
    action: 'customer_anonymised', targetType: 'customer', targetId: cust?.id ?? requestId,
    performedBy: actor.id, performedByType: actor.type, metadata: { request_id: requestId, counts },
  })
  return { ok: true, counts }
}

export async function rejectDeletionRequest(requestId: string, note: string | null, actor: { id: string; type: string }): Promise<boolean> {
  const { data } = await supabaseAdmin.from('data_deletion_requests')
    .update({ status: 'rejected', note: note?.slice(0, 500) || null, handled_by: actor.id, handled_at: new Date().toISOString() })
    .eq('id', requestId).eq('status', 'pending').select('id, customer_id')
  if (!data || data.length === 0) return false
  await writeAudit({
    action: 'data_deletion_rejected', targetType: 'customer', targetId: (data[0].customer_id as string | null) ?? requestId,
    performedBy: actor.id, performedByType: actor.type, metadata: { request_id: requestId },
  })
  return true
}
