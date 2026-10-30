import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { createPayout, detectMNO, isPawaPayTimeout } from '@/lib/pawapay'
import { normalizePhone } from '@/lib/phone'

export const dynamic = 'force-dynamic'

// /api/admin/pawapay/payout-test (R3) — SUPER ADMIN ONLY.
// POST { phone, amount }  a small payout (PAYOUT_TEST_MAX FCFA max) to a
//                         Cameroon Mobile Money number, to check payouts work.
// GET                     the last 10 tests.
// The row (id = PawaPay payoutId) is written BEFORE PawaPay is called.
const PAYOUT_TEST_MAX = 500

function superAdmin(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && s.role === 'super_admin' ? s : null
}

export async function GET(req: NextRequest) {
  if (!superAdmin(req)) return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  const { data } = await supabaseAdmin.from('payout_tests').select('*').order('created_at', { ascending: false }).limit(10)
  return NextResponse.json({ tests: data ?? [], max: PAYOUT_TEST_MAX }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const s = superAdmin(req)
  if (!s) return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const amount = Number(body.amount)
  if (!Number.isInteger(amount) || amount < 1 || amount > PAYOUT_TEST_MAX) {
    return NextResponse.json({ error: `Montant : 1 à ${PAYOUT_TEST_MAX} FCFA / Amount: 1 to ${PAYOUT_TEST_MAX} FCFA`, field: 'amount' }, { status: 400 })
  }
  const phone = normalizePhone(typeof body.phone === 'string' ? body.phone : '')
  const mno = phone.startsWith('+237') ? detectMNO(phone) : null
  if (!mno) return NextResponse.json({ error: 'Numéro MTN ou Orange Cameroun requis / MTN or Orange Cameroon number required', field: 'phone' }, { status: 400 })

  const id = randomUUID()
  const { error } = await supabaseAdmin.from('payout_tests').insert({ id, phone, amount, correspondent: mno.correspondent, requested_by: s.id })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await writeAudit({ action: 'payout_test_requested', targetType: 'platform', targetId: id, performedBy: s.id, performedByType: s.role, metadata: { phone, amount, correspondent: mno.correspondent } })

  try {
    const r = await createPayout({ payoutId: id, amount, currency: 'XAF', phoneNumber: phone, description: 'Test Tchop Ndjoka' })
    await supabaseAdmin.from('payout_tests').update({ pawapay_status: r.status }).eq('id', id).eq('status', 'pending')
  } catch (e) {
    if (!isPawaPayTimeout(e)) {
      const msg = (e as Error).message.slice(0, 300)
      await supabaseAdmin.from('payout_tests').update({ status: 'failed', pawapay_status: 'REJECTED', failure_reason: msg }).eq('id', id).eq('status', 'pending')
      await writeAudit({ action: 'payout_failed', targetType: 'platform', targetId: id, performedByType: 'system', metadata: { payout_id: id, reason: msg, test: true } })
      return NextResponse.json({ error: msg, id }, { status: 502 })
    }
  }
  const { data } = await supabaseAdmin.from('payout_tests').select('*').eq('id', id).single()
  return NextResponse.json({ ok: true, test: data })
}
