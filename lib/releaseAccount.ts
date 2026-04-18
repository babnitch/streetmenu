import crypto from 'crypto'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export function hashPhone(phone: string): string {
  return 'deleted_' + crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16)
}

export async function releaseAccount(customerId: string): Promise<void> {
  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, phone, deleted_at')
    .eq('id', customerId)
    .maybeSingle()

  if (!customer) return

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

  await Promise.all(expired.map(c => releaseAccount(c.id)))
  return expired.length
}
