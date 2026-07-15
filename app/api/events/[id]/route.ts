import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { normalizeMode, legacyEnabledFromMode } from '@/lib/paymentMode'
import { notifyEventUpdate, type SignificantChanges } from '@/lib/directMessaging'

export const dynamic = 'force-dynamic'

// PATCH /api/events/[id]
// Organizer (organizer_id === session.id) or admin only. Edits event details
// after publishing. Editable: title, description, date, time, venue,
// neighborhood, category, ticket_price, max_tickets, cover_photo, payment_mode,
// whatsapp_payment_enabled.
//
// On save, attendees are notified over WhatsApp — but only when a *significant*
// field changed (date / time / venue / price). Description-only edits stay
// silent. Returns { updated, notified_count }.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const { data: event } = await supabaseAdmin
    .from('events')
    .select('id, organizer_id, organizer_name, title, description, date, time, venue, neighborhood, category, ticket_price, max_tickets, cover_photo, payment_mode, whatsapp_payment_enabled, is_active')
    .eq('id', params.id)
    .maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (!isAdmin && event.organizer_id !== session.id) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const updates: Record<string, unknown> = {}

  // Plain text/date fields — only apply keys the caller actually sent.
  if (typeof body.title === 'string' && body.title.trim())   updates.title = body.title.trim()
  if ('description' in body)  updates.description  = body.description ? String(body.description).trim() : null
  if (typeof body.date === 'string' && body.date)            updates.date = body.date
  if ('time' in body)         updates.time         = body.time || null
  if ('venue' in body)        updates.venue        = body.venue || null
  if ('neighborhood' in body) updates.neighborhood = body.neighborhood || null
  if (typeof body.category === 'string' && body.category)    updates.category = body.category
  if ('cover_photo' in body)  updates.cover_photo  = body.cover_photo || null

  // Price + capacity — normalise like the submit route (0/null = free).
  let newPrice: number | null = event.ticket_price
  if ('ticket_price' in body || 'price' in body) {
    const raw = body.ticket_price ?? body.price
    newPrice = raw != null && raw !== '' ? Math.max(0, Math.round(Number(raw))) : null
    updates.ticket_price = newPrice
    updates.price = newPrice // legacy display column kept in sync
  }
  if ('max_tickets' in body) {
    updates.max_tickets = body.max_tickets != null && body.max_tickets !== ''
      ? Math.max(0, parseInt(String(body.max_tickets), 10)) : 0
  }

  // Payment mode — free events are forced to reservation_only + WhatsApp off.
  const effectivePrice = 'ticket_price' in updates ? (updates.ticket_price as number | null) : event.ticket_price
  const isPaid = !!(effectivePrice && effectivePrice > 0)
  if ('payment_mode' in body) {
    const mode = isPaid ? normalizeMode(body.payment_mode) : 'reservation_only'
    updates.payment_mode = mode
    updates.payment_enabled = legacyEnabledFromMode(mode)
  }
  if ('whatsapp_payment_enabled' in body) {
    updates.whatsapp_payment_enabled = isPaid ? !!body.whatsapp_payment_enabled : false
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Aucun champ à mettre à jour / Nothing to update' }, { status: 400 })
  }

  const { data: updated, error: updErr } = await supabaseAdmin
    .from('events').update(updates).eq('id', event.id)
    .select('id, title, date, time, venue')
    .single()
  if (updErr || !updated) {
    console.error('[events/PATCH] update failed:', updErr?.message)
    return NextResponse.json({ error: updErr?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  // Significant-change detection — compare against the pre-update snapshot.
  const changes: SignificantChanges = {}
  if ('date' in updates && updates.date !== event.date)   changes.date  = true
  if ('time' in updates && (updates.time ?? null) !== (event.time ?? null)) changes.time  = true
  if ('venue' in updates && (updates.venue ?? null) !== (event.venue ?? null)) changes.venue = true
  if ('ticket_price' in updates && (updates.ticket_price ?? null) !== (event.ticket_price ?? null)) {
    changes.price = { to: (updates.ticket_price as number | null) }
  }

  // notifyEventUpdate writes the event_updated audit row and, when a
  // significant field changed, pings attendees. Pending events have no
  // audience (you can't reserve a draft), so this safely returns 0 for them.
  const notified = await notifyEventUpdate(
    { id: updated.id, title: updated.title, date: updated.date, time: updated.time, venue: updated.venue },
    changes,
    session.id,
    session.role,
  )

  return NextResponse.json({ updated: true, notified_count: notified })
}
