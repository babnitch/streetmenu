import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { normalizePhone } from '@/lib/phone'
import { sanitizeText } from '@/lib/sanitize'
import { findOrCreateAccount } from '@/lib/ownerAccount'

export const dynamic = 'force-dynamic'

// POST /api/admin/events/[id]/organizer (N3) — the organiser of an event the
// admin listed with none.
//   { mode: 'notify', phone }      a number that gets the bookings
//                                  (events.notify_phone; '' clears it). The
//                                  event stays managed.
//   { mode: 'link', phone, name? } link an account (reused, or created — name
//                                  required for a new number): it becomes the
//                                  organiser, the event follows their modules
//                                  and stops being managed.
// Nobody is messaged. Audited. super_admin | admin.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const { data: ev } = await supabaseAdmin.from('events')
    .select('id, city, organizer_id, organizer_name, managed_by_platform, notify_phone').eq('id', params.id).maybeSingle()
  if (!ev) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  const raw = typeof body.phone === 'string' ? body.phone.trim() : ''
  const phone = raw ? normalizePhone(raw) : ''

  if (body.mode === 'notify') {
    if (phone && !/^\+\d{8,15}$/.test(phone)) {
      return NextResponse.json({ error: 'Numéro invalide / Invalid number', field: 'phone' }, { status: 400 })
    }
    const { error } = await supabaseAdmin.from('events').update({ notify_phone: phone || null }).eq('id', ev.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await writeAudit({
      action: 'event_notify_phone_set', targetType: 'event', targetId: ev.id,
      performedBy: session.id, performedByType: session.role,
      previousData: { notify_phone: ev.notify_phone }, metadata: { notify_phone: phone || null },
    })
    return NextResponse.json({ ok: true, notify_phone: phone || null })
  }

  if (body.mode === 'link') {
    if (ev.organizer_id) {
      return NextResponse.json({ error: 'Cet événement a déjà un organisateur / This event already has an organiser' }, { status: 409 })
    }
    const acc = await findOrCreateAccount(phone, sanitizeText(body.name, 60), ev.city, { id: session.id, type: session.role }, 'event_organizer')
    if (!acc.ok) return NextResponse.json({ error: acc.error, field: acc.field === 'owner_phone' ? 'phone' : 'name' }, { status: acc.status })
    const org = acc.account
    const keepName = ev.organizer_name && ev.organizer_name !== 'Tchop & Ndjoka'
    const { error } = await supabaseAdmin.from('events').update({
      organizer_id: org.id,
      whatsapp: org.phone,
      organizer_name: keepName ? ev.organizer_name : org.name,
      managed_by_platform: false,
      // I6: with an organiser, the event takes bookings on the platform.
      booking_mode: 'platform',
    }).eq('id', ev.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await writeAudit({
      action: 'event_organizer_linked', targetType: 'event', targetId: ev.id,
      performedBy: session.id, performedByType: session.role,
      metadata: { organizer_id: org.id, phone: org.phone, account_created: acc.created },
    })
    return NextResponse.json({ ok: true, organizer: { id: org.id, name: org.name, phone: org.phone } })
  }

  return NextResponse.json({ error: 'mode: notify | link' }, { status: 400 })
}
