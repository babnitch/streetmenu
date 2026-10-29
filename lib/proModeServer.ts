// Pro actions need Pro mode, on the server too (not only hidden buttons).
// The mode is the one saved on the account (customers.default_mode), which
// the Client ⇄ Pro switch and the "Passer en mode Pro" button write.
// Admins have no mode: always allowed. Server-only.

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

const ADMIN = ['super_admin', 'admin', 'moderator']

export async function inProMode(session: { id: string; role: string }): Promise<boolean> {
  if (ADMIN.includes(session.role)) return true
  if (session.role !== 'customer') return false
  const { data } = await supabaseAdmin.from('customers').select('default_mode').eq('id', session.id).maybeSingle()
  return data?.default_mode === 'pro'
}

export const CLIENT_MODE_TEXT = 'Passez en mode Pro pour valider / Switch to Pro mode to validate'

// null when allowed, else the 403 to return (reason: client_mode).
export async function requireProMode(session: { id: string; role: string }): Promise<NextResponse | null> {
  if (await inProMode(session)) return null
  return NextResponse.json({ error: CLIENT_MODE_TEXT, reason: 'client_mode', state: 'refused' }, { status: 403 })
}
