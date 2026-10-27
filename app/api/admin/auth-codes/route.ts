import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// GET /api/admin/auth-codes — Admin → Messages → "Codes de connexion".
// The login-code send log (auth_code_sends) for the last 24 h: how many were
// sent / failed / blocked (and why), against the daily cap in
// platform_settings, plus the latest 100 attempts. super_admin / admin only
// (phone numbers and IPs are personal data).
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [rowsRes, capRes] = await Promise.all([
    supabaseAdmin.from('auth_code_sends')
      .select('id, phone, ip, channel, status, reason, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(0, 999),
    supabaseAdmin.from('platform_settings').select('value').eq('key', 'auth_codes_daily_cap').maybeSingle(),
  ])
  if (rowsRes.error) {
    console.error('[admin/auth-codes] read failed:', rowsRes.error.message)
    return NextResponse.json({ error: rowsRes.error.message }, { status: 500 })
  }
  const rows = rowsRes.data ?? []
  const count = (st: string) => rows.filter(r => r.status === st).length
  const blockedBy: Record<string, number> = {}
  for (const r of rows) if (r.status === 'blocked') blockedBy[r.reason ?? '?'] = (blockedBy[r.reason ?? '?'] ?? 0) + 1

  return NextResponse.json({
    cap:      Number(capRes.data?.value ?? 40),
    sent:     count('sent'),
    failed:   count('failed'),
    blocked:  count('blocked'),
    blockedBy,
    recent:   rows.slice(0, 100),
  })
}
