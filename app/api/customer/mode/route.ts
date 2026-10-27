import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// PATCH /api/customer/mode — { mode: 'client' | 'pro' }
// Saves the mode the account opens in after a login (customers.default_mode),
// so it follows the person to every device. Called by the Client ⇄ Pro switch
// in Mon compte.
export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({}))
  const mode = body?.mode
  if (mode !== 'client' && mode !== 'pro') {
    return NextResponse.json({ error: 'mode: client | pro' }, { status: 400 })
  }
  const { error } = await supabaseAdmin.from('customers').update({ default_mode: mode }).eq('id', session.id)
  if (error) {
    console.error('[customer/mode] update failed:', error.message)
    return NextResponse.json({ error: 'Erreur — réessayez. / Error — please try again.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, mode })
}
