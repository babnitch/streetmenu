import { supabaseAdmin } from '@/lib/supabaseAdmin'

export interface AuditEntry {
  action: string
  targetType: 'customer' | 'restaurant' | 'admin_user' | 'restaurant_team' | 'voucher' | 'order'
  targetId: string
  performedBy?: string | null
  performedByType?: string | null
  previousData?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
}

// Non-throwing: an audit outage must never break an admin workflow.
// Callers that REQUIRE the trace before proceeding (e.g. number_released)
// should write their own hard-fail version.
export async function writeAudit(entry: AuditEntry): Promise<void> {
  const { error } = await supabaseAdmin.from('audit_log').insert({
    action:            entry.action,
    target_type:       entry.targetType,
    target_id:         entry.targetId,
    performed_by:      entry.performedBy ?? null,
    performed_by_type: entry.performedByType ?? null,
    previous_data:     entry.previousData ?? null,
    metadata:          entry.metadata ?? null,
  })
  if (error) {
    console.error(`[audit] ${entry.action} on ${entry.targetType}/${entry.targetId} — insert failed:`, error.message)
  }
}
