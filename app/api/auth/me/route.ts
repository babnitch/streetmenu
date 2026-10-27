import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest, clearSessionCookie } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'

// GET /api/auth/me — who is logged in.
//
// A customer session is re-checked against the account: suspended, deleted
// or gone → the session ends here (cookie cleared, user: null), so a
// suspension takes effect on the next page load instead of when the 30-day
// cookie expires. The name comes from the account, not the cookie, so a
// rename shows at once.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session) {
    return NextResponse.json({ user: null }, { status: 200 })
  }
  if (session.role !== 'customer') {
    return NextResponse.json({ user: session })
  }

  const { data: c, error } = await supabaseAdmin
    .from('customers').select('name, phone, status, deleted_at').eq('id', session.id).maybeSingle()
  if (error) {
    // A database hiccup must not log everyone out: keep the session as is.
    console.error('[auth/me] customer read failed:', error.message)
    return NextResponse.json({ user: session })
  }
  if (!c || c.status === 'suspended' || c.status === 'deleted' || c.deleted_at) {
    return clearSessionCookie(NextResponse.json({ user: null, ended: c ? c.status ?? 'deleted' : 'missing' }))
  }
  return NextResponse.json({ user: { ...session, name: c.name ?? session.name, phone: c.phone ?? session.phone } })
}
