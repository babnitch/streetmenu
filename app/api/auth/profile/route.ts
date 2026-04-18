import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET — full customer row for the logged-in customer. Includes fields the
// JWT session doesn't carry (city, status, created_at, deleted_at, etc.).
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin
    .from('customers')
    .select('id, name, phone, city, status, suspended_at, suspended_by, suspension_reason, deleted_at, created_at')
    .eq('id', session.id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Profil introuvable / Profile not found' }, { status: 404 })

  return NextResponse.json({ profile: data })
}
