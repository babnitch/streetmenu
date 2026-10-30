import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { clientIP } from '@/lib/rateLimit'
import { signCodeTicket } from '@/lib/auth'
import { adminLock, sendAdminCode } from '@/lib/adminLogin'

export const dynamic = 'force-dynamic'

// POST /api/auth/admin-resend — "Pas reçu ? Renvoyer / Recevoir par SMS" on
// the team code screen. Body: { challenge, channel: 'whatsapp' | 'sms' }.
// Only a live challenge (issued after the right password, unused, not
// expired) can ask for a new code; the new one replaces it. Same per-number
// limits as any code (30 s between sends, hourly caps).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const challenge = typeof body?.challenge === 'string' ? body.challenge : ''
  const channel = body?.channel === 'sms' ? 'sms' : 'whatsapp'
  if (!/^[0-9a-f-]{36}$/i.test(challenge)) return NextResponse.json({ error: 'Recommencez. / Start again.', restart: true }, { status: 400 })

  const { data: ch } = await supabaseAdmin.from('admin_login_challenges')
    .select('admin_id, used, expires_at').eq('id', challenge).maybeSingle()
  if (!ch || ch.used || new Date(ch.expires_at as string) < new Date()) {
    return NextResponse.json({ error: 'Code expiré. Recommencez. / Code expired. Start again.', restart: true }, { status: 400 })
  }
  const { data: admin } = await supabaseAdmin.from('admin_users')
    .select('id, email, status, phone').eq('id', ch.admin_id).maybeSingle()
  if (!admin || admin.status !== 'active' || !admin.phone) {
    return NextResponse.json({ error: 'Recommencez. / Start again.', restart: true }, { status: 403 })
  }
  const ip = clientIP(req)
  const lock = await adminLock(String(admin.email).toLowerCase(), ip)
  if (lock.locked) {
    const min = Math.max(1, Math.ceil(lock.retryAfter / 60))
    return NextResponse.json({ error: `Connexion bloquée. Réessayez dans ${min} min. / Login locked. Try again in ${min} min.`, locked: true }, { status: 429 })
  }
  const sent = await sendAdminCode({ id: admin.id as string, phone: admin.phone as string }, ip, channel)
  if (!sent.ok) return NextResponse.json({ error: sent.error, retry_after: sent.retryAfter }, { status: sent.status })
  return NextResponse.json({ step: 'code', challenge: sent.challengeId, channel: sent.channel, sentTo: sent.maskedPhone, ticket: signCodeTicket(admin.phone as string) })
}
