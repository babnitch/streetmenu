// Server-only: "Demander l'activation" (M5).
//
// A pro asks for a module → one module_requests row (at most one pending per
// pro and module, enforced by the DB) and one WhatsApp to each active
// super-admin with a phone. The admin accepts or declines in Admin →
// Demandes: accepting switches the module on (with what it needs, audited),
// and the pro gets one WhatsApp either way.
//
// No payment for modules yet.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { writeAudit } from '@/lib/audit'
import { moduleInfo, modulesFor, type ModuleSubject } from '@/lib/modules'
import { switchModule } from '@/lib/modulesServer'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://streetmenu.vercel.app'

export type RequestResult =
  | { ok: true; id: string; alreadyPending: boolean }
  | { ok: false; status: number; error: string }

// Who may ask: a restaurant's owner (direct or owner team row); an organiser
// for their own account.
async function ownsRestaurant(customerId: string, restaurantId: string): Promise<{ name: string } | null> {
  const { data: r } = await supabaseAdmin.from('restaurants').select('id, name, customer_id, deleted_at').eq('id', restaurantId).maybeSingle()
  if (!r || r.deleted_at) return null
  if (r.customer_id === customerId) return { name: r.name as string }
  const { data: t } = await supabaseAdmin.from('restaurant_team').select('role')
    .eq('restaurant_id', restaurantId).eq('customer_id', customerId).eq('status', 'active').eq('role', 'owner').maybeSingle()
  return t ? { name: r.name as string } : null
}

export async function requestModule(customerId: string, subject: ModuleSubject, module: string, restaurantId?: string | null): Promise<RequestResult> {
  if (!modulesFor(subject).includes(module)) return { ok: false, status: 400, error: 'Module inconnu / Unknown module' }

  const { data: me } = await supabaseAdmin.from('customers').select('id, name, phone, organizer_modules').eq('id', customerId).maybeSingle()
  if (!me) return { ok: false, status: 404, error: 'Compte introuvable / Account not found' }

  let label = ''
  if (subject === 'restaurant') {
    if (!restaurantId) return { ok: false, status: 400, error: 'restaurant_id requis / required' }
    const own = await ownsRestaurant(customerId, restaurantId)
    if (!own) return { ok: false, status: 403, error: 'Réservé au propriétaire du restaurant / Restaurant owner only' }
    const { data: r } = await supabaseAdmin.from('restaurants').select('modules').eq('id', restaurantId).maybeSingle()
    if (((r?.modules as string[] | null) ?? []).includes(module)) return { ok: false, status: 409, error: 'Module déjà activé / Module already on' }
    label = `🏪 ${own.name}`
  } else {
    if (((me.organizer_modules as string[] | null) ?? []).includes(module)) return { ok: false, status: 409, error: 'Module déjà activé / Module already on' }
    label = '🎉 organisateur / organiser'
  }

  const row = {
    subject_type: subject,
    restaurant_id: subject === 'restaurant' ? restaurantId : null,
    customer_id: subject === 'organizer' ? customerId : null,
    module,
    requested_by: customerId,
  }
  const { data: created, error } = await supabaseAdmin.from('module_requests').insert(row).select('id').single()
  if (error) {
    // 23505 = the one-pending-per-module index: already asked, nothing to do.
    if (error.code === '23505') {
      let q = supabaseAdmin.from('module_requests').select('id').eq('module', module).eq('status', 'pending')
      q = subject === 'restaurant' ? q.eq('restaurant_id', restaurantId!) : q.eq('customer_id', customerId)
      const { data: existing } = await q.maybeSingle()
      return { ok: true, id: (existing?.id as string) ?? '', alreadyPending: true }
    }
    return { ok: false, status: 500, error: error.message }
  }

  await writeAudit({
    action: 'module_requested', targetType: subject === 'restaurant' ? 'restaurant' : 'customer',
    targetId: (subject === 'restaurant' ? restaurantId : customerId)!, performedBy: customerId, performedByType: 'customer',
    metadata: { module, request_id: created.id },
  })
  await notifyAdmins(subject, module, me.name as string, me.phone as string, label, created.id as string)
  return { ok: true, id: created.id as string, alreadyPending: false }
}

async function notifyAdmins(subject: ModuleSubject, module: string, who: string, phone: string, label: string, requestId: string): Promise<void> {
  const info = moduleInfo(subject, module)!
  const { data: admins } = await supabaseAdmin.from('admin_users').select('phone')
    .eq('role', 'super_admin').eq('status', 'active').not('phone', 'is', null)
  const link = `${BASE_URL}/admin/${subject === 'restaurant' ? 'restaurants' : 'events'}`
  await Promise.allSettled((admins ?? []).map(async a => {
    const lang = await getLangByPhone(a.phone as string)
    return sendWhatsApp(a.phone as string, pickLang(
      `🧩 *Demande de module*\n\n${who} (${phone}) demande « ${info.fr} » — ${label}.\n\nRépondre : ${link}`,
      `🧩 *Module request*\n\n${who} (${phone}) asks for "${info.en}" — ${label}.\n\nAnswer: ${link}`,
      lang,
    ), { context: 'account_notice', relatedId: requestId })
  }))
}

export type DecideResult = { ok: true; modules?: string[] } | { ok: false; status: number; error: string }

export async function decideModuleRequest(requestId: string, approve: boolean, admin: { id: string; type: string }): Promise<DecideResult> {
  const { data: req } = await supabaseAdmin.from('module_requests')
    .select('id, subject_type, restaurant_id, customer_id, module, requested_by, status').eq('id', requestId).maybeSingle()
  if (!req) return { ok: false, status: 404, error: 'Demande introuvable / Request not found' }
  if (req.status !== 'pending') return { ok: false, status: 409, error: 'Demande déjà traitée / Request already answered' }
  const subject = req.subject_type as ModuleSubject
  const targetId = (subject === 'restaurant' ? req.restaurant_id : req.customer_id) as string

  let modules: string[] | undefined
  if (approve) {
    const sw = await switchModule(subject, targetId, req.module as string, true, admin, 'request_approved')
    if (!sw.ok) return { ok: false, status: sw.status, error: sw.error }
    modules = sw.after
  }
  // Only the call that flips 'pending' answers (a double click does nothing).
  const { data: flipped } = await supabaseAdmin.from('module_requests')
    .update({ status: approve ? 'approved' : 'declined', decided_by: admin.id, decided_at: new Date().toISOString() })
    .eq('id', requestId).eq('status', 'pending').select('id')
  if (!flipped || flipped.length === 0) return { ok: true, modules }

  await writeAudit({
    action: approve ? 'module_request_approved' : 'module_request_declined',
    targetType: subject === 'restaurant' ? 'restaurant' : 'customer', targetId,
    performedBy: admin.id, performedByType: admin.type, metadata: { module: req.module, request_id: requestId },
  })

  // One WhatsApp to the pro who asked.
  if (req.requested_by) {
    const { data: pro } = await supabaseAdmin.from('customers').select('phone').eq('id', req.requested_by).maybeSingle()
    let where = ''
    if (subject === 'restaurant') {
      const { data: r } = await supabaseAdmin.from('restaurants').select('name').eq('id', targetId).maybeSingle()
      where = r?.name ? ` — ${r.name}` : ''
    }
    if (pro?.phone) {
      const info = moduleInfo(subject, req.module as string)!
      const lang = await getLangByPhone(pro.phone as string)
      await sendWhatsApp(pro.phone as string, approve
        ? pickLang(`✅ Module « ${info.fr} » activé${where}. Il est disponible dès maintenant dans votre espace Pro.`,
                   `✅ "${info.en}" module enabled${where}. It's available now in your Pro space.`, lang)
        : pickLang(`ℹ️ Votre demande pour le module « ${info.fr} »${where} n'a pas été acceptée pour l'instant.`,
                   `ℹ️ Your request for the "${info.en}" module${where} wasn't accepted for now.`, lang),
        { context: 'account_notice', relatedId: requestId, customerId: req.requested_by as string })
    }
  }
  return { ok: true, modules }
}
