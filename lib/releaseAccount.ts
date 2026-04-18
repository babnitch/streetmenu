import crypto from 'crypto'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

// Produce a unique anonymised phone token. Every call returns a fresh value
// so re-releasing a previously-released phone (e.g. after a number was
// re-registered by a new customer) never collides with the prior anonymised
// row on the customers.phone UNIQUE constraint.
//
// 8 random bytes (16 hex chars) — matches the historical length of the
// old deterministic hash, birthday-collision-safe well past any plausible
// number of releases.
export function anonymisedPhoneToken(): string {
  return 'deleted_' + crypto.randomBytes(8).toString('hex')
}

// Retained for any external caller of the old deterministic hasher. New code
// should use anonymisedPhoneToken(). The argument is ignored on purpose —
// identical inputs MUST produce distinct outputs now.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function hashPhone(_input: string): string {
  return anonymisedPhoneToken()
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

  const anonymisedCustomerPhone = anonymisedPhoneToken()
  const now = new Date().toISOString()

  // Anonymise the customer. We .select() back so the query always returns
  // rows-written count and so any UNIQUE / RLS / trigger error surfaces —
  // before this check was added the UPDATE could fail silently and leave
  // the customer LIVE despite an audit_log row saying "released".
  const { data: custRows, error: custUpdErr } = await supabaseAdmin.from('customers').update({
    name:       'Deleted User',
    phone:      anonymisedCustomerPhone,
    status:     'deleted',
    deleted_at: customer.deleted_at ?? now,
  }).eq('id', customerId).select('id')

  if (custUpdErr) {
    console.error(
      `[releaseAccount] customer UPDATE failed code=${(custUpdErr as { code?: string }).code} ` +
      `msg="${custUpdErr.message}" details="${(custUpdErr as { details?: string }).details ?? ''}"`
    )
    throw new Error(`Customer anonymisation failed: ${custUpdErr.message}`)
  }
  if (!custRows?.length) {
    console.error('[releaseAccount] customer UPDATE matched 0 rows — id mismatch or RLS block')
    throw new Error('Customer anonymisation matched no rows')
  }

  // Anonymise each restaurant. Doing them one-by-one so each gets its own
  // unique whatsapp token (same collision risk as customers).
  for (const r of ownedRestaurants ?? []) {
    const { error: restUpdErr } = await supabaseAdmin.from('restaurants').update({
      name:       'Deleted Restaurant',
      whatsapp:   anonymisedPhoneToken(),
      status:     'deleted',
      deleted_at: now,
    }).eq('id', r.id)

    if (restUpdErr) {
      console.error(
        `[releaseAccount] restaurant ${r.id} UPDATE failed code=${(restUpdErr as { code?: string }).code} ` +
        `msg="${restUpdErr.message}"`
      )
      throw new Error(`Restaurant anonymisation failed for ${r.id}: ${restUpdErr.message}`)
    }
  }

  // Remove all team entries for this customer
  const { error: teamErr } = await supabaseAdmin.from('restaurant_team')
    .delete()
    .eq('customer_id', customerId)

  if (teamErr) {
    console.error(`[releaseAccount] restaurant_team delete failed: ${teamErr.message}`)
    // Non-fatal: customer + restaurants already anonymised. Log and continue.
  }

  console.log(`[releaseAccount] done — ${customerId} anonymised (${ownedRestaurants?.length ?? 0} restaurants)`)
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
