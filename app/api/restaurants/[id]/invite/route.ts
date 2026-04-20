import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sendWhatsApp } from '@/lib/whatsapp'
import { writeAudit } from '@/lib/audit'
import { normalizePhone } from '@/lib/phone'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/invite
//
// Owner-only team invitation. Mirrors the WhatsApp "ajouter +XXX role" flow:
//
//   - If the phone is already an active customer → insert a restaurant_team
//     row immediately (same as POST /team) and fire the welcome WhatsApp.
//   - If the phone isn't a customer yet → write a pending row into
//     team_invitations and fire an invitation WhatsApp with accept/decline
//     instructions. The invitee replies on WhatsApp to finish the flow.
//
// A pending invitation to the same (restaurant, phone) is rejected up-front
// so owners don't spam the same invitee. Owners can cancel via the dashboard
// or WhatsApp "annuler invitation +XXX" before re-inviting.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: ownerEntry } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()

  if (!ownerEntry || ownerEntry.role !== 'owner') {
    return NextResponse.json({ error: 'Seul le propriétaire peut inviter / Only owner can invite' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const phone = normalizePhone(body.phone)
  const role  = body.role as string
  if (!phone || !['manager', 'staff'].includes(role)) {
    return NextResponse.json({ error: 'Numéro et rôle requis / Phone and role required' }, { status: 400 })
  }

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants').select('id, name').eq('id', params.id).maybeSingle()
  if (!restaurant) {
    return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
  }

  // Path 1: known customer → add directly to team.
  const { data: existingCustomer } = await supabaseAdmin
    .from('customers').select('id, name, phone, status')
    .eq('phone', phone).maybeSingle()

  if (existingCustomer && existingCustomer.status === 'active') {
    const { error: insertErr } = await supabaseAdmin.from('restaurant_team').upsert({
      restaurant_id: restaurant.id,
      customer_id:   existingCustomer.id,
      role,
      added_by:      session.id,
      status:        'active',
    }, { onConflict: 'restaurant_id,customer_id' })

    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 })

    await writeAudit({
      action: 'team_member_added',
      targetType: 'restaurant_team',
      targetId: existingCustomer.id,
      performedBy: session.id,
      performedByType: 'vendor',
      metadata: {
        restaurant_id: restaurant.id,
        restaurant_name: restaurant.name,
        role,
        member_name: existingCustomer.name,
        member_phone: existingCustomer.phone,
        via: 'invite-endpoint-direct',
      },
    })

    await sendWhatsApp(existingCustomer.phone,
      `✅ *${session.name}* vous a ajouté comme *${role}* chez *${restaurant.name}*!\n` +
      `Connectez-vous pour voir votre restaurant.\n\n` +
      `*${session.name}* added you as *${role}* at *${restaurant.name}*.\n` +
      `Log in to see your restaurant.`)

    return NextResponse.json({
      ok: true,
      mode: 'added',
      member: { id: existingCustomer.id, name: existingCustomer.name, phone: existingCustomer.phone },
    })
  }

  // Path 2: new number → record invitation + send invite on WhatsApp.
  // Guard against spamming the same invitee with multiple pending rows.
  const { data: existingPending } = await supabaseAdmin
    .from('team_invitations')
    .select('id, expires_at')
    .eq('restaurant_id', restaurant.id).eq('phone', phone).eq('status', 'pending')
    .maybeSingle()

  if (existingPending && new Date(existingPending.expires_at) > new Date()) {
    return NextResponse.json({
      error: 'Une invitation est déjà en attente pour ce numéro / A pending invitation already exists',
    }, { status: 409 })
  }

  // Expire any stale pending rows so the partial unique index doesn't block
  // a fresh invitation. Lazy cleanup — the row is no longer actionable.
  if (existingPending) {
    await supabaseAdmin
      .from('team_invitations')
      .update({ status: 'expired' })
      .eq('id', existingPending.id)
  }

  const { data: invitation, error: invErr } = await supabaseAdmin
    .from('team_invitations')
    .insert({
      restaurant_id: restaurant.id,
      phone,
      role,
      invited_by: session.id,
      status: 'pending',
    })
    .select('id, expires_at')
    .single()

  if (invErr || !invitation) {
    return NextResponse.json({ error: invErr?.message ?? 'Insert failed' }, { status: 500 })
  }

  await writeAudit({
    action: 'team_invitation_sent',
    targetType: 'restaurant_team',
    targetId: invitation.id,
    performedBy: session.id,
    performedByType: 'vendor',
    metadata: {
      restaurant_id: restaurant.id,
      restaurant_name: restaurant.name,
      role,
      invited_phone: phone,
      via: 'invite-endpoint',
    },
  })

  await sendWhatsApp(phone,
    `👋 *${session.name}* vous invite comme *${role}* chez *${restaurant.name}* sur Ndjoka & Tchop!\n\n` +
    `Envoyez *accepter* pour rejoindre. Vous serez inscrit automatiquement.\n` +
    `Envoyez *refuser* pour décliner.\n\n` +
    `*${session.name}* invites you as *${role}* at *${restaurant.name}* on Ndjoka & Tchop!\n` +
    `Send *accept* to join — you'll be registered automatically.\n` +
    `Send *decline* to decline.`)

  return NextResponse.json({
    ok: true,
    mode: 'invited',
    invitation: { id: invitation.id, phone, role, expires_at: invitation.expires_at },
  })
}

// GET /api/restaurants/[id]/invite — list pending invitations. Owner only.
// Expired rows aren't filtered here — they're returned so the UI can render
// "expired" badges instead of silently vanishing.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: ownerEntry } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()

  if (!ownerEntry || ownerEntry.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data } = await supabaseAdmin
    .from('team_invitations')
    .select('id, phone, role, status, created_at, expires_at')
    .eq('restaurant_id', params.id)
    .in('status', ['pending'])
    .order('created_at', { ascending: false })

  return NextResponse.json({ invitations: data ?? [] })
}
