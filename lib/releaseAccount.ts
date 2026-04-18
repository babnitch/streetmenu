import crypto from 'crypto'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export function hashPhone(phone: string): string {
  return 'deleted_' + crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16)
}

export interface ReleaseActor {
  id?: string | null
  type?: string | null   // 'super_admin' | 'admin' | 'system' | ...
}

export async function releaseAccount(customerId: string, actor: ReleaseActor = { type: 'system' }): Promise<void> {
  console.log(`[releaseAccount] start customerId=${customerId} actor=${actor.type ?? 'system'}`)

  // Read the full pre-anonymisation snapshot so we can persist it to audit_log.
  const { data: customer, error: customerErr } = await supabaseAdmin
    .from('customers')
    .select('id, name, phone, city, status, deleted_at, created_at')
    .eq('id', customerId)
    .maybeSingle()

  if (customerErr) {
    console.error('[releaseAccount] customers fetch failed:', customerErr.message)
    throw new Error(`Customer fetch failed: ${customerErr.message}`)
  }
  if (!customer) {
    console.warn(`[releaseAccount] no customer row for id=${customerId} — nothing to release`)
    return
  }

  const { data: ownedRestaurants, error: restErr } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, city, whatsapp, status')
    .eq('customer_id', customerId)

  if (restErr) {
    console.error('[releaseAccount] restaurants fetch failed:', restErr.message)
    throw new Error(`Restaurants fetch failed: ${restErr.message}`)
  }

  console.log(`[releaseAccount] snapshot ready — ${ownedRestaurants?.length ?? 0} restaurants, writing audit_log…`)

  // Write the audit entry BEFORE anonymising. If this fails we abort the
  // release so we never destroy data without a trace.
  const { error: auditError } = await supabaseAdmin.from('audit_log').insert({
    action:            'number_released',
    target_type:       'customer',
    target_id:         customerId,
    performed_by:      actor.id ?? null,
    performed_by_type: actor.type ?? 'system',
    previous_data: {
      customer: {
        name:       customer.name,
        phone:      customer.phone,
        city:       customer.city,
        status:     customer.status,
        deleted_at: customer.deleted_at,
        created_at: customer.created_at,
      },
      restaurants: (ownedRestaurants ?? []).map(r => ({
        id:       r.id,
        name:     r.name,
        city:     r.city,
        whatsapp: r.whatsapp,
        status:   r.status,
      })),
    },
  })

  if (auditError) {
    // PostgreSQL's "relation does not exist" — the audit_log table hasn't
    // been created in this DB yet. Surface an actionable error so the admin
    // knows exactly which migration to run.
    const code    = (auditError as { code?: string }).code
    const details = (auditError as { details?: string }).details
    const hint    = (auditError as { hint?: string }).hint
    console.error(
      '[releaseAccount] audit_log insert failed — aborting release to protect PII trace. ' +
      `code=${code ?? '?'} message="${auditError.message}" details="${details ?? ''}" hint="${hint ?? ''}"`
    )

    if (code === '42P01' || /audit_log/i.test(auditError.message)) {
      throw new Error(
        'Table audit_log manquante — exécutez supabase-audit-log.sql dans Supabase avant de libérer un numéro. ' +
        'The audit_log table is missing — run supabase-audit-log.sql in Supabase before releasing a number.'
      )
    }

    throw new Error(
      `Audit log write failed — release aborted. ${auditError.message}`
    )
  }

  console.log('[releaseAccount] audit_log write OK — anonymising…')

  const hashedPhone = hashPhone(customer.phone ?? '')
  const now = new Date().toISOString()

  // Anonymize the customer record
  await supabaseAdmin.from('customers').update({
    name:       'Deleted User',
    phone:      hashedPhone,
    status:     'deleted',
    deleted_at: customer.deleted_at ?? now,
  }).eq('id', customerId)

  // Anonymize all restaurants owned by this customer
  await supabaseAdmin.from('restaurants').update({
    name:       'Deleted Restaurant',
    whatsapp:   hashPhone((customer.phone ?? '') + '_rest'),
    status:     'deleted',
    deleted_at: now,
  }).eq('customer_id', customerId)

  // Remove all team entries for this customer
  await supabaseAdmin.from('restaurant_team')
    .delete()
    .eq('customer_id', customerId)

  console.log(`[releaseAccount] done — ${customerId} anonymised`)
}

export async function releaseExpiredAccounts(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: expired } = await supabaseAdmin
    .from('customers')
    .select('id')
    .eq('status', 'deleted')
    .lt('deleted_at', cutoff)
    .not('phone', 'like', 'deleted_%')

  if (!expired?.length) return 0

  // system-initiated cleanup
  await Promise.all(expired.map(c => releaseAccount(c.id, { type: 'system' })))
  return expired.length
}
