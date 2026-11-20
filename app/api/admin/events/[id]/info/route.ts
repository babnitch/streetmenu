import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { editEvent, loadEventForEdit, activeBookingCount, eventPinReady } from '@/lib/eventEdit'

export const dynamic = 'force-dynamic'

// Admin « Infos de l'événement » (any published event: managed or an
// organiser's). super_admin | admin. Same checks as the organiser form
// (lib/eventEdit.ts), plus the booking mode, the « Billets / Infos » link and
// the map pin. Audited old → new (event_info_changed).
//
// GET → { event, bookings, pin_ready }  (bookings = active ones)
// PUT { …fields, notify?: boolean } → { updated, notified_count, changed }
//   notify: when the date / time / venue / price changes, tell the people
//   who booked on WhatsApp (the admin chooses; default: no).

function admin(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && ['super_admin', 'admin'].includes(s.role) ? s : null
}
const validId = (id: string) => /^[0-9a-f-]{36}$/i.test(id)
const notFound = () => NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!admin(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  if (!validId(params.id)) return notFound()
  const event = await loadEventForEdit(params.id)
  if (!event || event.event_status === 'rejected') return notFound()
  const [bookings, pinReady] = await Promise.all([activeBookingCount(event.id), eventPinReady()])
  return NextResponse.json({ event, bookings, pin_ready: pinReady })
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = admin(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  if (!validId(params.id)) return notFound()
  const event = await loadEventForEdit(params.id)
  if (!event) return notFound()
  const raw = await req.json().catch(() => ({}))
  const body: Record<string, unknown> = raw && typeof raw === 'object' ? { ...raw } : {}
  const notify = body.notify === true
  delete body.notify
  // The poster, its credit and focus go through /api/admin/events/[id]/photo.
  for (const k of ['cover_photo', 'blur_hash', 'cover_focus', 'photo_credit', 'organizer_id', 'managed_by_platform', 'event_status', 'is_active']) delete body[k]
  return editEvent(event, body, { id: session.id, role: session.role, isAdmin: true },
    { enforceModules: true, notify, adminFields: true })
}
