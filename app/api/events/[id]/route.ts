import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { isEventOrganizer } from '@/lib/eventAuth'
import { editEvent, loadEventForEdit } from '@/lib/eventEdit'

export const dynamic = 'force-dynamic'

// PATCH /api/events/[id]
// Organizer (organizer_id === session.id) or admin only. Edits event details
// after publishing. Editable: title, description, date, time, end_date, end_time, venue,
// neighborhood, category, city, ticket_price, price_is_from, max_tickets,
// cover_photo (+ cover_focus), organizer_name, whatsapp, notify_phone,
// payment_mode, whatsapp_payment_enabled. The rules live in lib/eventEdit.ts
// (shared with the admin « Infos de l'événement » panel).
//
// On save, attendees are notified over WhatsApp — but only when a *significant*
// field changed (date / time / venue / price). Description-only edits stay
// silent. Returns { updated, notified_count, changed }.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const event = await loadEventForEdit(params.id)
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (!isAdmin && !isEventOrganizer(event, session.id)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  return editEvent(event, body && typeof body === 'object' ? body : {}, { id: session.id, role: session.role, isAdmin },
    { enforceModules: !isAdmin, notify: 'auto', adminFields: false })
}
