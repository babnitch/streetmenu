import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { isEventOrganizer } from '@/lib/eventAuth'
import { writeAudit } from '@/lib/audit'
import { normalizePhone } from '@/lib/phone'
import { sanitizeText } from '@/lib/sanitize'
import { findOrCreateAccount } from '@/lib/ownerAccount'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { SITE_URL } from '@/lib/siteLinks'
import { formatEventDates } from '@/lib/eventDate'

export const dynamic = 'force-dynamic'

// /api/events/[id]/door-staff (Q4) — people who may scan / check in the
// tickets of THIS event, nothing else (no money, no editing, no list).
// GET                       the list
// POST   { phone, name? }   add (existing account, or a new one); they get
//                           one WhatsApp with the scanner link
// DELETE { customer_id }    remove — their access ends at once
// The organiser, or an admin (also for managed events).

async function authorize(req: NextRequest, eventId: string) {
  const session = getSessionFromRequest(req)
  if (!session) return { error: NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 }) }
  const { data: ev } = await supabaseAdmin.from('events')
    .select('id, title, city, organizer_id, submitted_by, date, end_date, time, end_time').eq('id', eventId).maybeSingle()
  if (!ev) return { error: NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 }) }
  const admin = ['super_admin', 'admin'].includes(session.role)
  if (!admin && !(session.role === 'customer' && isEventOrganizer(ev, session.id))) {
    return { error: NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 }) }
  }
  return { session, ev, admin }
}

async function list(eventId: string) {
  const { data } = await supabaseAdmin.from('event_door_staff')
    .select('customer_id, created_at, customers!event_door_staff_customer_id_fkey(name, phone)')
    .eq('event_id', eventId).eq('status', 'active').order('created_at', { ascending: true })
  return ((data ?? []) as unknown as Array<{ customer_id: string; customers: { name: string; phone: string } | null }>)
    .map(r => ({ customer_id: r.customer_id, name: r.customers?.name ?? '', phone: r.customers?.phone ?? '' }))
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id)
  if ('error' in a) return a.error
  return NextResponse.json({ staff: await list(params.id) }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id)
  if ('error' in a) return a.error
  const body = await req.json().catch(() => ({})) as { phone?: unknown; name?: unknown }
  const phone = normalizePhone(typeof body.phone === 'string' ? body.phone : '')
  const name = sanitizeText(body.name, 60) || 'Contrôle'
  const acc = await findOrCreateAccount(phone, name, a.ev.city, { id: a.session.id, type: a.session.role }, 'door_staff')
  if (!acc.ok) return NextResponse.json({ error: acc.error, field: 'phone' }, { status: acc.status })
  if (acc.account.id === a.ev.organizer_id) {
    return NextResponse.json({ error: 'C\'est l\'organisateur / That is the organiser' }, { status: 409 })
  }
  const { data: existing } = await supabaseAdmin.from('event_door_staff').select('status')
    .eq('event_id', a.ev.id).eq('customer_id', acc.account.id).maybeSingle()
  if (existing?.status === 'active') return NextResponse.json({ error: 'Déjà au contrôle / Already on the door' }, { status: 409 })
  const { error } = await supabaseAdmin.from('event_door_staff').upsert({
    event_id: a.ev.id, customer_id: acc.account.id, status: 'active',
    added_by: a.session.role === 'customer' ? a.session.id : null,
  }, { onConflict: 'event_id,customer_id' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await writeAudit({
    action: 'door_staff_added', targetType: 'event', targetId: a.ev.id,
    performedBy: a.session.id, performedByType: a.admin ? a.session.role : 'organizer',
    metadata: { customer_id: acc.account.id, phone: acc.account.phone, account_created: acc.created },
  })
  const lang = await getLangByPhone(acc.account.phone)
  await sendWhatsApp(acc.account.phone, pickLang(
    `🚪 Vous pouvez contrôler les billets de *${a.ev.title}* (${formatEventDates(a.ev, 'fr', 'message')}).\n\nOuvrez le scanner (connectez-vous avec ce numéro) :\n${SITE_URL}/scanner?event=${a.ev.id}`,
    `🚪 You can check tickets for *${a.ev.title}* (${formatEventDates(a.ev, 'en', 'message')}).\n\nOpen the scanner (log in with this number):\n${SITE_URL}/scanner?event=${a.ev.id}`,
    lang,
  ), { context: 'account_notice', relatedId: a.ev.id, customerId: acc.account.id })
  return NextResponse.json({ ok: true, staff: await list(a.ev.id) })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id)
  if ('error' in a) return a.error
  const body = await req.json().catch(() => ({})) as { customer_id?: unknown }
  const cid = String(body.customer_id ?? '')
  const { data } = await supabaseAdmin.from('event_door_staff').update({ status: 'removed' })
    .eq('event_id', a.ev.id).eq('customer_id', cid).eq('status', 'active').select('id')
  if (!data || data.length === 0) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  await writeAudit({
    action: 'door_staff_removed', targetType: 'event', targetId: a.ev.id,
    performedBy: a.session.id, performedByType: a.admin ? a.session.role : 'organizer', metadata: { customer_id: cid },
  })
  return NextResponse.json({ ok: true, staff: await list(a.ev.id) })
}
