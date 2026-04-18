import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const targetId = params.id

  if (session.role === 'customer' && session.id !== targetId) {
    return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
  }
  if (session.role === 'moderator') {
    return NextResponse.json({ error: 'Permission insuffisante / Insufficient permission' }, { status: 403 })
  }

  const now = new Date().toISOString()

  const { error: custError } = await supabaseAdmin
    .from('customers')
    .update({ status: 'deleted', deleted_at: now })
    .eq('id', targetId)

  if (custError) {
    console.error('[delete account] customer update error:', custError)
    return NextResponse.json({ error: custError.message }, { status: 500 })
  }

  const { error: restError } = await supabaseAdmin
    .from('restaurants')
    .update({ status: 'deleted', deleted_at: now })
    .eq('customer_id', targetId)
    .is('deleted_at', null)

  if (restError) {
    console.error('[delete account] restaurants update error:', restError)
  }

  return NextResponse.json({ ok: true })
}
