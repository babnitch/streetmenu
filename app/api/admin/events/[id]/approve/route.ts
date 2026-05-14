import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp } from '@/lib/whatsapp'

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
    .select('id, title, is_active, organizer_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })

  const wasInactive = !event.is_active

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

      if (grantAuto) {
        await writeAudit({
          action:          'auto_approve_granted',
          targetType:      'customer',
          targetId:        organizer.id,
          performedBy:     session.id,
          performedByType: session.role,
          metadata:        { threshold: AUTO_APPROVE_THRESHOLD, events_approved_count: nextCount },
        })
        if (organizer.phone) {
          await sendWhatsApp(organizer.phone,
            `🎉 *Éditeur vérifié! / Verified publisher!*\n\n` +
            `Vos prochains événements seront publiés immédiatement.\n` +
            `Your next events will publish immediately.`,
          ).catch(() => null)
        }
      }

      if (organizer.phone) {
        await sendWhatsApp(organizer.phone,
          `✅ *Événement approuvé! / Event approved!*\n\n🎉 ${event.title}\n\nVisible sur Ndjoka & Tchop. / Live on Ndjoka & Tchop.`,
        ).catch(() => null)
      }
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

  return NextResponse.json({ ok: true, newly_granted_auto: newlyGrantedAuto })
}
