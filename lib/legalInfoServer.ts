// Legal & contact info on the server (U1): read (60 s cache) and save
// (admin, audited). Stored in platform_settings 'legal_contact'; under the
// local test guard a separate 'test_legal_contact' row, so tests never
// change the live footer.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { testGuardPrefix } from '@/lib/testGuard'
import { validateLegalInfo, type LegalInfo, type LegalValidation } from '@/lib/legalInfo'

const KEY = `${testGuardPrefix() ? 'test_' : ''}legal_contact`
const AUDIT_ID = '00000000-0000-0000-0000-00000000a003'
let cache: { at: number; value: LegalInfo } | null = null

export async function getLegalInfo(): Promise<LegalInfo> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', KEY).maybeSingle()
  const v = validateLegalInfo(data?.value ?? {})
  const value = v.ok ? v.info : {}
  cache = { at: Date.now(), value }
  return value
}

export async function setLegalInfo(raw: unknown, actor: { id: string; type: string }): Promise<LegalValidation> {
  const v = validateLegalInfo(raw)
  if (!v.ok) return v
  const before = await getLegalInfo()
  const { error } = await supabaseAdmin.from('platform_settings')
    .upsert({ key: KEY, value: v.info, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) return { ok: false, error: error.message, field: 'company_name' }
  cache = { at: Date.now(), value: v.info }
  await writeAudit({
    action: 'legal_contact_updated', targetType: 'platform', targetId: AUDIT_ID,
    performedBy: actor.id, performedByType: actor.type, previousData: before, metadata: v.info,
  })
  return v
}
