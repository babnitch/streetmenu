import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { verifyCodeTicket } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/auth/code-channel?ticket=… — did the login code this ticket was
// issued with go out by SMS after all (WhatsApp fallback, lib/smsFallback)?
// { channel: 'sms' | 'whatsapp' }. The ticket names the number, so nobody
// can ask about another one.
export async function GET(req: NextRequest) {
  const t = verifyCodeTicket(req.nextUrl.searchParams.get('ticket'))
  if (!t) return NextResponse.json({ error: 'ticket' }, { status: 400 })
  const { data } = await supabaseAdmin.from('message_log')
    .select('id').eq('to_number', t.phone).eq('channel', 'sms').eq('context', 'verification_code')
    .gte('created_at', t.since).neq('status', 'failed').limit(1)
  return NextResponse.json({ channel: (data ?? []).length > 0 ? 'sms' : 'whatsapp' }, { headers: { 'Cache-Control': 'no-store' } })
}
