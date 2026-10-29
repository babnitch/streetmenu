// The account behind a phone number, for admin actions that name a person by
// phone (create a restaurant with its owner, change the owner — N3): reuse
// the existing account, or create one for a new number (a name is then
// required). Suspended accounts are refused. Server-only.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'

export interface OwnerAccount { id: string; name: string; phone: string; status?: string | null }
export type OwnerAccountResult =
  | { ok: true; account: OwnerAccount; created: boolean }
  | { ok: false; status: number; error: string; field: string }

export async function findOrCreateAccount(
  phone: string, name: string, city: string | null,
  actor: { id: string; type: string }, purpose: string,
): Promise<OwnerAccountResult> {
  if (!/^\+\d{8,15}$/.test(phone)) {
    return { ok: false, status: 400, error: 'Téléphone invalide / Invalid phone', field: 'owner_phone' }
  }
  const { data: found } = await supabaseAdmin
    .from('customers').select('id, name, phone, status')
    .in('phone', [phone, phone.slice(1)])
    .limit(1)
  const existing = found?.[0] ?? null
  if (existing?.status === 'suspended') {
    return { ok: false, status: 409, error: 'Compte suspendu / Account suspended', field: 'owner_phone' }
  }
  if (existing) return { ok: true, account: existing as OwnerAccount, created: false }

  if (!name) {
    return { ok: false, status: 400, error: 'Nouveau numéro : nom requis / New number: name required', field: 'owner_name' }
  }
  const { data: created, error } = await supabaseAdmin
    .from('customers').insert({ phone, name, city: city || 'Yaoundé', preferred_language: 'fr' })
    .select('id, name, phone, status').single()
  if (error || !created) {
    console.error('[ownerAccount] insert failed:', error?.message)
    return { ok: false, status: 500, error: 'Erreur serveur / Server error', field: 'owner_phone' }
  }
  await writeAudit({
    action: 'customer_created_by_admin', targetType: 'customer', targetId: created.id,
    performedBy: actor.id, performedByType: actor.type, metadata: { phone, for: purpose },
  })
  return { ok: true, account: created as OwnerAccount, created: true }
}
