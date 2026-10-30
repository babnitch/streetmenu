import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { pickLang } from '@/lib/whatsapp'
import { notifyOrganizer } from '@/lib/eventRecipients'
import { notifyEventSubscribers } from '@/lib/subscriptions'
import { EVENT_DATE_COLUMNS } from '@/lib/eventDate'
import { validateModules } from '@/lib/modules'
import { setOrganizerModules, organizerModules } from '@/lib/modulesServer'

export const dynamic = 'force-dynamic'

const AUTO_APPROVE_THRESHOLD = 3

// POST /api/admin/events/[id]/approve
// Admin/moderator action. Flips is_active=true, bumps the submitter's
// events_approved_count, and grants event_auto_approve when the count
// crosses 3 (audited as auto_approve_granted). Pings the submitter.
//
// Idempotent: re-approving an already-active event still re-sends the
// confirmation but doesn't double-count. Counter only bumps on the first
// transition from inactive → active.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: event } = await supabaseAdmin
    .from('events')
    .select(`id, title, is_active, event_status, organizer_id, ${EVENT_DATE_COLUMNS}, venue, city, category, price, ticket_price`)
    .eq('id', params.id)
    .maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (event.event_status === 'rejected') {
    return NextResponse.json({ error: 'Événement rejeté — ne peut pas être approuvé / Rejected event — cannot be approved' }, { status: 409 })
  }

  const wasInactive = !event.is_active

  // Approve + activate in one step (M1): for an organiser's first event the
  // screen sends their modules (Réservations pre-ticked). Admins only —
  // a moderator's approval leaves the modules as they are.
  const body = await req.json().catch(() => ({}))
  const isAdmin = ['super_admin', 'admin'].includes(session.role)
  let modulesToSet: string[] | null = null
  if (body?.modules !== undefined && isAdmin && event.organizer_id) {
    const v = validateModules('organizer', body.modules)
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
    modulesToSet = v.modules
  }

  if (wasInactive) {
    await supabaseAdmin.from('events').update({ is_active: true }).eq('id', event.id)
  }

  // Counter + trust gate only run for first-time approval.
  let newlyGrantedAuto = false
  if (wasInactive && event.organizer_id) {
    const { data: organizer } = await supabaseAdmin
      .from('customers')
      .select('id, name, phone, events_approved_count, event_auto_approve')
      .eq('id', event.organizer_id)
      .maybeSingle()
    if (organizer) {
      const nextCount = (organizer.events_approved_count ?? 0) + 1
      const grantAuto = !organizer.event_auto_approve && nextCount >= AUTO_APPROVE_THRESHOLD
      newlyGrantedAuto = grantAuto

      await supabaseAdmin
        .from('customers')
        .update({
          events_approved_count: nextCount,
          ...(grantAuto ? { event_auto_approve: true } : {}),
        })
        .eq('id', organizer.id)

      // Modules: the list from the screen, plus Auto-approbation when this
      // approval earned it. setOrganizerModules keeps event_auto_approve in step.
      if (modulesToSet || grantAuto) {
        const base = modulesToSet ?? await organizerModules(organizer.id)
        const next = grantAuto && !base.includes('auto_approve') ? [...base, 'auto_approve'] : base
        await setOrganizerModules(organizer.id, next, { id: session.id, type: session.role }, grantAuto ? 'auto_approve_granted' : 'approval')
      }

      if (grantAuto) {
        await writeAudit({
          action:          'auto_approve_granted',
          targetType:      'customer',
          targetId:        organizer.id,
          performedBy:     session.id,
          performedByType: session.role,
          metadata:        { threshold: AUTO_APPROVE_THRESHOLD, events_approved_count: nextCount },
        })
      }

      // One message: the approval, plus — when this approval made them a
      // verified organiser — that their next events publish at once (no
      // separate "Organisateur vérifié" message).
      await notifyOrganizer(event, lang => pickLang(
        `✅ *Événement approuvé!*\n\n🎉 ${event.title}\n\nVisible sur Tchop & Ndjoka.` +
          (grantAuto ? `\n\n🎉 Vous êtes organisateur vérifié : vos prochains événements seront publiés immédiatement.` : ''),
        `✅ *Event approved!*\n\n🎉 ${event.title}\n\nLive on Tchop & Ndjoka.` +
          (grantAuto ? `\n\n🎉 You're a verified organiser: your next events will publish immediately.` : ''),
        lang,
      ), { context: 'event_update', relatedId: event.id }, organizer.phone ?? null)
    }
  }

  await writeAudit({
    action:          'event_approved',
    targetType:      'event',
    targetId:        event.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { is_active: event.is_active },
    metadata:        { title: event.title, organizer_id: event.organizer_id, newly_granted_auto: newlyGrantedAuto },
  })

  // Fan-out to subscribers only on the first activation; re-approving an
  // already-active event would otherwise spam subscribers each time.
  if (wasInactive) {
    try {
      const fan = await notifyEventSubscribers({
        id:           event.id,
        title:        event.title,
        date:         (event as { date: string }).date,
        time:         (event as { time: string | null }).time,
        end_date:     (event as { end_date: string | null }).end_date,
        end_time:     (event as { end_time: string | null }).end_time,
        venue:        (event as { venue: string | null }).venue,
        city:         (event as { city: string }).city,
        category:     (event as { category: string }).category,
        price:        (event as { price: number | null }).price,
        ticket_price: (event as { ticket_price: number | null }).ticket_price,
      })
      if (fan.recipient_count > 0) {
        await writeAudit({
          action:          'event_notification_sent',
          targetType:      'event',
          targetId:        event.id,
          performedBy:     session.id,
          performedByType: session.role,
          metadata:        { recipient_count: fan.recipient_count, ok: fan.ok, failed: fan.failed, via: 'admin_approve' },
        })
      }
    } catch (e) {
      console.error('[admin/events/approve] notifyEventSubscribers failed:', (e as Error).message)
    }
  }

  return NextResponse.json({ ok: true, newly_granted_auto: newlyGrantedAuto })
}
