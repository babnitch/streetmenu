// Team invitation (manager / staff), shared by the owner's dashboard
// (POST /api/restaurants/[id]/invite) and the admin restaurant card (N3).
//
//   - The phone is already an active customer → restaurant_team row at once
//     + "added you" WhatsApp.
//   - Otherwise → pending team_invitations row + invitation WhatsApp; the
//     invitee replies accept / decline on WhatsApp.
// One pending invitation per (restaurant, phone). Server-only.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { writeAudit } from '@/lib/audit'
import { wouldStripLastOwner, LAST_OWNER_ERROR } from '@/lib/vendorAccess'

export interface Inviter {
  /** customers.id of the inviting owner; null for a platform admin. */
  customerId: string | null
  /** Shown in the message: the owner's name, or "Tchop & Ndjoka". */
  name: string
  /** For the audit log. */
  actorId: string
  actorType: string
  via: string
}

export type InviteResult =
  | { ok: true; mode: 'added'; member: { id: string; name: string; phone: string } }
  | { ok: true; mode: 'invited'; invitation: { id: string; phone: string; role: string; expires_at: string } }
  | { ok: false; status: number; error: string }

export async function inviteTeamMember(
  restaurant: { id: string; name: string }, phone: string, role: 'manager' | 'staff', inviter: Inviter,
): Promise<InviteResult> {
  // Path 1: known customer → add directly to team.
  const { data: existingCustomer } = await supabaseAdmin
    .from('customers').select('id, name, phone, status')
    .eq('phone', phone).maybeSingle()

  if (existingCustomer && existingCustomer.status === 'active') {
    // Inviting yourself at a lower role would demote the last owner.
    if (await wouldStripLastOwner(restaurant.id, existingCustomer.id, role)) {
      return { ok: false, status: 409, error: LAST_OWNER_ERROR }
    }
    const { error: insertErr } = await supabaseAdmin.from('restaurant_team').upsert({
      restaurant_id: restaurant.id,
      customer_id:   existingCustomer.id,
      role,
      added_by:      inviter.customerId,
      status:        'active',
    }, { onConflict: 'restaurant_id,customer_id' })
    if (insertErr) return { ok: false, status: 500, error: insertErr.message }

    await writeAudit({
      action: 'team_member_added', targetType: 'restaurant_team', targetId: existingCustomer.id,
      performedBy: inviter.actorId, performedByType: inviter.actorType,
      metadata: {
        restaurant_id: restaurant.id, restaurant_name: restaurant.name, role,
        member_name: existingCustomer.name, member_phone: existingCustomer.phone, via: `${inviter.via}-direct`,
      },
    })
    const addedLang = await getLangByPhone(existingCustomer.phone)
    await sendWhatsApp(existingCustomer.phone, pickLang(
      `✅ *${inviter.name}* vous a ajouté comme *${role}* chez *${restaurant.name}*!\n` +
      `Connectez-vous pour voir votre restaurant.`,
      `✅ *${inviter.name}* added you as *${role}* at *${restaurant.name}*!\n` +
      `Log in to see your restaurant.`,
      addedLang,
    ), { context: 'team_invitation', relatedId: restaurant.id, customerId: existingCustomer.id })

    return { ok: true, mode: 'added', member: { id: existingCustomer.id, name: existingCustomer.name, phone: existingCustomer.phone } }
  }

  // Path 2: new number → record invitation + send invite on WhatsApp.
  const { data: existingPending } = await supabaseAdmin
    .from('team_invitations')
    .select('id, expires_at')
    .eq('restaurant_id', restaurant.id).eq('phone', phone).eq('status', 'pending')
    .maybeSingle()

  if (existingPending && new Date(existingPending.expires_at) > new Date()) {
    return { ok: false, status: 409, error: 'Une invitation est déjà en attente pour ce numéro / A pending invitation already exists' }
  }
  // Expire a stale pending row so the partial unique index doesn't block a
  // fresh invitation.
  if (existingPending) {
    await supabaseAdmin.from('team_invitations').update({ status: 'expired' }).eq('id', existingPending.id)
    await writeAudit({
      action: 'team_invitation_expired', targetType: 'restaurant_team', targetId: existingPending.id,
      performedBy: inviter.actorId, performedByType: 'system',
      metadata: { restaurant_id: restaurant.id, phone, via: `${inviter.via}-replace` },
    })
  }

  const { data: invitation, error: invErr } = await supabaseAdmin
    .from('team_invitations')
    .insert({ restaurant_id: restaurant.id, phone, role, invited_by: inviter.customerId, status: 'pending' })
    .select('id, expires_at')
    .single()
  if (invErr || !invitation) return { ok: false, status: 500, error: invErr?.message ?? 'Insert failed' }

  await writeAudit({
    action: 'team_invitation_sent', targetType: 'restaurant_team', targetId: invitation.id,
    performedBy: inviter.actorId, performedByType: inviter.actorType,
    metadata: { restaurant_id: restaurant.id, restaurant_name: restaurant.name, role, invited_phone: phone, via: inviter.via },
  })

  const inviteLang = await getLangByPhone(phone)
  await sendWhatsApp(phone, pickLang(
    `👋 *${inviter.name}* vous invite comme *${role}* chez *${restaurant.name}* sur Tchop & Ndjoka!\n\n` +
    `Envoyez *accepter* pour rejoindre. Vous serez inscrit automatiquement.\n` +
    `Envoyez *refuser* pour décliner.`,
    `👋 *${inviter.name}* invites you as *${role}* at *${restaurant.name}* on Tchop & Ndjoka!\n\n` +
    `Send *accept* to join — you'll be registered automatically.\n` +
    `Send *decline* to decline.`,
    inviteLang,
  ), { context: 'team_invitation', relatedId: restaurant.id })

  return { ok: true, mode: 'invited', invitation: { id: invitation.id, phone, role, expires_at: invitation.expires_at } }
}
