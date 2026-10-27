// Which order-status changes message the customer (decision D, fewer
// messages):
//   - "delivered" never: every order is picked up, the customer is there;
//   - "preparing" not when "confirmed" went out in the last 10 minutes
//     (the two usually come seconds apart — one message is enough);
//   - everything else (confirmed, ready, cancelled) always.

import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const PREPARING_QUIET_MS = 10 * 60 * 1000

export async function shouldMessageStatus(orderId: string, status: string): Promise<boolean> {
  if (status === 'delivered') return false
  if (status !== 'preparing') return true
  const since = new Date(Date.now() - PREPARING_QUIET_MS).toISOString()
  const { data, error } = await supabaseAdmin.from('message_log')
    .select('id').eq('related_id', orderId).eq('context', 'order_status_update')
    .gte('created_at', since).neq('status', 'failed').limit(1)
  if (error) return true                     // unsure → send rather than stay silent
  return (data ?? []).length === 0
}
