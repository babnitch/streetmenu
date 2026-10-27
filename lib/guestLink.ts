// Guest data → account. When someone logs in or creates an account with a
// verified phone number (they just proved they own it with a code), the
// orders they placed as a guest with that number are attached to their
// account, so they show in "Mes commandes".
//
// Orders are the only guest data today: bookings, vouchers, ratings, likes
// and comments all need a login already. Matching is on the normalised
// number (samePhone: last 9 digits), so "+237 670…" typed at checkout
// matches the account's "+237670…".
//
// Best-effort: a failure is logged, never blocks the login.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { samePhone } from '@/lib/phone'

export async function linkGuestData(customerId: string, phone: string): Promise<number> {
  const tail = phone.replace(/\D/g, '').slice(-9)
  if (tail.length < 6) return 0
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('id, customer_phone')
      .is('customer_id', null)
      // Candidates: ending in the same last 4 digits, whatever spaces or
      // dashes sit between them. samePhone below does the real comparison.
      .like('customer_phone', `%${tail.slice(-4).split('').join('%')}`)
      .range(0, 499)
    if (error) throw new Error(error.message)
    const ids = (data ?? []).filter(o => samePhone(o.customer_phone as string, phone)).map(o => o.id as string)
    if (ids.length === 0) return 0
    const { error: upErr } = await supabaseAdmin
      .from('orders').update({ customer_id: customerId }).in('id', ids).is('customer_id', null)
    if (upErr) throw new Error(upErr.message)
    console.log(`[guest-link] attached ${ids.length} guest order(s) to customer=${customerId}`)
    return ids.length
  } catch (e) {
    console.error('[guest-link] failed for customer=%s: %s', customerId, (e as Error).message)
    return 0
  }
}
