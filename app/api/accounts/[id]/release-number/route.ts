import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'super_admin') {
    return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  }

  const { data: customer } = await supabaseAdmin
    .from('customers').select('id, phone, deleted_at')
    .eq('id', params.id).maybeSingle()

  if (!customer) return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })

  // Anonymize PII
  const hashedPhone = 'deleted_' + crypto.createHash('sha256').update(customer.phone ?? '').digest('hex').slice(0, 16)
  await supabaseAdmin.from('customers').update({
    name:   'Deleted User',
    phone:  hashedPhone,
    status: 'deleted',
    deleted_at: customer.deleted_at ?? new Date().toISOString(),
  }).eq('id', params.id)

  return NextResponse.json({ ok: true })
}
