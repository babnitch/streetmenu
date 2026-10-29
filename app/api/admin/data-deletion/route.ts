import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sanitizeText } from '@/lib/sanitize'
import { createDeletionRequest, anonymiseAccount, rejectDeletionRequest } from '@/lib/dataDeletion'

export const dynamic = 'force-dynamic'

// /api/admin/data-deletion (U2) — Admin → Plateforme → Demandes de suppression.
// GET   pending requests first, then the last 50 handled
// POST  { action: 'create', phone, reason? }   e.g. a request received by mail
//       { action: 'anonymise', id }             anonymise the account
//       { action: 'reject', id, note? }
// Admin / super_admin; audited.
function authorize(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && ['super_admin', 'admin'].includes(s.role) ? s : null
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const cols = 'id, phone, reason, via, status, customer_id, created_at, handled_at, note, customers!data_deletion_requests_customer_id_fkey(name)'
  const [{ data: pending }, { data: done }] = await Promise.all([
    supabaseAdmin.from('data_deletion_requests').select(cols).eq('status', 'pending').order('created_at', { ascending: true }),
    supabaseAdmin.from('data_deletion_requests').select(cols).neq('status', 'pending').order('handled_at', { ascending: false }).limit(50),
  ])
  return NextResponse.json({ pending: pending ?? [], handled: done ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const s = authorize(req)
  if (!s) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const actor = { id: s.id, type: s.role }
  if (body.action === 'create') {
    const r = await createDeletionRequest(String(body.phone ?? ''), sanitizeText(body.reason, 500) || null, 'web')
    return r.ok ? NextResponse.json({ ok: true, id: r.id }) : NextResponse.json({ error: r.error }, { status: 400 })
  }
  if (body.action === 'anonymise') {
    const r = await anonymiseAccount(String(body.id ?? ''), actor)
    return r.ok ? NextResponse.json({ ok: true, counts: r.counts }) : NextResponse.json({ error: r.error }, { status: r.status })
  }
  if (body.action === 'reject') {
    const ok = await rejectDeletionRequest(String(body.id ?? ''), sanitizeText(body.note, 500) || null, actor)
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Demande introuvable / Not found' }, { status: 404 })
  }
  return NextResponse.json({ error: 'action' }, { status: 400 })
}
