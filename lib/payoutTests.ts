// R3 — the outcome of an admin payout test, written once (pending →
// completed | failed) by whichever comes first: PawaPay's payout callback
// (/api/payments/webhook) or the admin's status check. completed_at is when
// the operator says the money arrived (receivedByRecipient), else now.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'

export async function settlePayoutTest(id: string, status: string, failure: string | null, receivedAt: string | null): Promise<'completed' | 'failed' | 'not_final' | 'already_settled'> {
  const terminal = status === 'COMPLETED' ? 'completed' : status === 'FAILED' || status === 'REJECTED' ? 'failed' : null
  if (!terminal) {
    await supabaseAdmin.from('payout_tests').update({ pawapay_status: status }).eq('id', id).eq('status', 'pending')
    return 'not_final'
  }
  const { data } = await supabaseAdmin.from('payout_tests')
    .update({ status: terminal, pawapay_status: status, failure_reason: failure, completed_at: terminal === 'completed' ? (receivedAt ?? new Date().toISOString()) : null })
    .eq('id', id).eq('status', 'pending').select('id, amount, phone').maybeSingle()
  if (!data) return 'already_settled'
  await writeAudit({ action: terminal === 'completed' ? 'payout_completed' : 'payout_failed', targetType: 'platform', targetId: id, performedByType: 'system', metadata: { payout_id: id, amount: data.amount, status, failure, test: true } })
  return terminal
}
