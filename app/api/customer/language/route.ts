import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// POST /api/customer/language  { language: 'fr' | 'en' }
// Persists the logged-in customer's language preference to
// customers.preferred_language — the value getLangByPhone reads when it
// localises WhatsApp notifications. The web language toggle only touched
// localStorage before, so a customer who switched the site to French still
// got English WhatsApp messages (the DB value was stale). This closes that gap.
//
// Non-customers (guests, admins) get a quiet 401 — the toggle calls this
// best-effort and ignores the result.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const language = body?.language === 'en' ? 'en' : body?.language === 'fr' ? 'fr' : null
  if (!language) {
    return NextResponse.json({ error: 'language must be fr or en' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('customers')
    .update({ preferred_language: language })
    .eq('id', session.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  console.log('[language] customer=%s preferred_language set to %s', session.id, language)
  return NextResponse.json({ ok: true, language })
}
