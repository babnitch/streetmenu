import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp } from '@/lib/whatsapp'
import { notifyEventSubscribers } from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

// POST /api/events/submit
// Body: full event payload (title, description, date, time, venue, city,
// neighborhood, category, price/ticket_price, max_tickets, payment_enabled,
// cover_photo URL, whatsapp, organizer_name).
//
// Trust gate: when the submitter's customers.event_auto_approve is TRUE,
// the event lands with is_active=true + auto_approved=true. Otherwise
// is_active=false (admin reviews via /admin/events). Either way, the
// customer's events_submitted_count is bumped on success.
//
// Login required (Option 2 in the spec) — guests fall back to 401, and the
// /events/submit page shunts them to /account.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  if (!body?.title || !body?.date || !body?.city || !body?.category || !body?.whatsapp) {
    return NextResponse.json({
      error: 'Champs requis manquants / Missing required fields',
    }, { status: 400 })
  }

  // Trust read — used to decide auto_approved + is_active.
  const { data: submitter } = await supabaseAdmin
    .from('customers')
    .select('id, name, phone, event_auto_approve, events_submitted_count')
    .eq('id', session.id)
    .maybeSingle()
  if (!submitter) {
    return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })
  }
  const autoApprove = !!submitter.event_auto_approve

  // Price + capacity normalisation. ticket_price 0 (or null) means free.
  // payment_enabled is ignored for free events; coerce to false so the
  // detail page doesn't surface a "Pay" CTA on something that costs nothing.
  const rawTicketPrice = body.ticket_price ?? body.price
  const ticketPrice = rawTicketPrice != null && rawTicketPrice !== ''
    ? Math.max(0, Math.round(Number(rawTicketPrice)))
    : null
  const maxTickets = body.max_tickets != null && body.max_tickets !== ''
    ? Math.max(0, parseInt(String(body.max_tickets), 10))
    : 0
  const paymentEnabled = ticketPrice && ticketPrice > 0 ? !!body.payment_enabled : false

  const insertRow: Record<string, unknown> = {
    title:           String(body.title).trim(),
    description:     body.description ? String(body.description).trim() : null,
    date:            body.date,
    time:            body.time || null,
    venue:           body.venue || null,
    city:            body.city,
    neighborhood:    body.neighborhood || null,
    category:        body.category,
    price:           ticketPrice,        // legacy display column
    ticket_price:    ticketPrice,
    max_tickets:     maxTickets,
    payment_enabled: paymentEnabled,
    cover_photo:     body.cover_photo || null,
    whatsapp:        body.whatsapp,
    organizer_name:  body.organizer_name || submitter.name,
    organizer_id:    submitter.id,
    is_active:       autoApprove,
    auto_approved:   autoApprove,
    event_status:    'upcoming',
  }

  const { data: event, error: insErr } = await supabaseAdmin
    .from('events').insert(insertRow).select('id, title').single()
  if (insErr || !event) {
    console.error('[events/submit] insert failed:', insErr?.message)
    return NextResponse.json({ error: insErr?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  // Bump submitter's events_submitted_count. Read-modify-write — fine at
  // this scale. The approval counter is bumped in /admin/events/[id]/approve
  // (or auto-bumped here when autoApprove is true so the gate stays
  // consistent for the submitter's next try).
  await supabaseAdmin
    .from('customers')
    .update({ events_submitted_count: (submitter.events_submitted_count ?? 0) + 1 })
    .eq('id', submitter.id)

  await writeAudit({
    action:          'event_submitted',
    targetType:      'event',
    targetId:        event.id,
    performedBy:     submitter.id,
    performedByType: 'customer',
    metadata: {
      title:        event.title,
      auto_approved: autoApprove,
      ticket_price:  ticketPrice,
      max_tickets:   maxTickets,
    },
  })

  if (autoApprove) {
    await writeAudit({
      action:          'event_auto_approved',
      targetType:      'event',
      targetId:        event.id,
      performedBy:     submitter.id,
      performedByType: 'customer',
      metadata: { reason: 'event_auto_approve=true' },
    })
  }

  // WhatsApp confirmation to the submitter. Best effort — submission has
  // already succeeded by this point.
  if (submitter.phone) {
    const msg = autoApprove
      ? `✅ *Événement publié! / Event published!*\n\n🎉 ${event.title}\n\nVisible immédiatement sur Ndjoka & Tchop. / Live immediately on Ndjoka & Tchop.`
      : `✅ *Événement soumis! / Event submitted!*\n\n🎉 ${event.title}\n\nIl sera visible après approbation par un admin. / It will be visible after admin approval.`
    await sendWhatsApp(submitter.phone, msg).catch(() => null)
  }

  // Fan-out to subscribers when the event went live immediately (verified
  // publisher). Admin-approval path notifies inside the /approve route.
  if (autoApprove) {
    try {
      const fan = await notifyEventSubscribers({
        id:           event.id,
        title:        String(insertRow.title),
        date:         String(insertRow.date),
        time:         insertRow.time as string | null,
        venue:        insertRow.venue as string | null,
        city:         String(insertRow.city),
        category:     String(insertRow.category),
        price:        ticketPrice,
        ticket_price: ticketPrice,
      })
      if (fan.recipient_count > 0) {
        await writeAudit({
          action:     'event_notification_sent',
          targetType: 'event',
          targetId:   event.id,
          performedBy:     submitter.id,
          performedByType: 'system',
          metadata:   { recipient_count: fan.recipient_count, ok: fan.ok, failed: fan.failed, via: 'auto_approve' },
        })
      }
    } catch (e) {
      console.error('[events/submit] notifyEventSubscribers failed:', (e as Error).message)
    }
  }

  return NextResponse.json({
    ok:            true,
    event_id:      event.id,
    auto_approved: autoApprove,
  })
}
