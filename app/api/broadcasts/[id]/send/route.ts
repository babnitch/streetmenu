import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { normalizeLang, type Lang } from '@/lib/whatsapp'
import {
  findMatchingSubscribers,
  fanoutBatched,
  formatBroadcastMessage,
} from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

// ── Internal-caller authentication ──────────────────────────────────────────
// This route is the ONLY thing in the app that emits bulk WhatsApp, and it
// used to have no authentication at all — its single guard was
// status === 'paid', which made it world-callable by anyone who learned a
// broadcast id during the window between payment and fan-out.
//
// Same header shape as app/api/admin/cleanup-expired/route.ts (the existing
// machine-caller pattern) but a DIFFERENT secret: CRON_SECRET belongs to
// Vercel cron and is handed to a third party, so reusing it here would widen
// what a leaked cron secret can do. Secrets stay scoped to one job.
//
// Constant-time compare rather than the `===` the cleanup route uses. A
// deliberate improvement, not an inconsistency: `===` short-circuits on the
// first differing byte, which leaks the secret's prefix through response
// timing. Free to do correctly, and this is a security fix.
const BEARER = 'Bearer '

type AuthOutcome =
  | { ok: true }
  | { ok: false; status: 401 | 503; logLine: string }

function authorizeInternal(req: NextRequest): AuthOutcome {
  const secret = process.env.INTERNAL_API_SECRET

  // FAIL CLOSED, LOUDLY. An unset secret must never mean "allow everyone" —
  // that is exactly how the original hole reads, and it is the same failure
  // class as a missing env var silently disabling webhook verification.
  // 503 rather than 401 so the cause is distinguishable in logs and
  // monitoring: 401 means someone called with the wrong credential, 503
  // means this deployment cannot authenticate anyone at all.
  if (!secret) {
    return {
      ok: false,
      status: 503,
      logLine:
        'INTERNAL_API_SECRET is not set on this deployment — refusing EVERY call, ' +
        'including the payment webhook\'s own. Broadcasts will be marked paid but ' +
        'never fan out. Set INTERNAL_API_SECRET in Vercel (Production), redeploy, ' +
        'then re-POST this route for any broadcast stuck at status=paid.',
    }
  }

  const header = req.headers.get('authorization') ?? ''
  if (!header.startsWith(BEARER)) {
    return { ok: false, status: 401, logLine: 'missing or malformed Authorization header' }
  }

  const provided = Buffer.from(header.slice(BEARER.length))
  const expected = Buffer.from(secret)
  // timingSafeEqual throws on a length mismatch, so that is checked first —
  // the length of a secret is not itself the secret.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, logLine: 'bearer token did not match' }
  }

  return { ok: true }
}

// POST /api/broadcasts/[id]/send
// Called by the PawaPay webhook (and as a self-serve retry) once the
// deposit completes. Loads the broadcast, queries the audience, fans out
// over WhatsApp. Idempotent — status must be 'paid' to fire; otherwise
// returns 409.
//
// AUTHORIZATION: Authorization: Bearer <INTERNAL_API_SECRET>. The only
// legitimate caller is /api/payments/webhook on the same deployment. The
// status === 'paid' check below STAYS as a second guard — the secret proves
// who is calling, the status proves the broadcast was actually paid for, and
// neither substitutes for the other.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = authorizeInternal(req)
  if (!auth.ok) {
    console.error(`[broadcasts/send] REFUSED (${auth.status}) for broadcast=${params.id}: ${auth.logLine}`)
    return NextResponse.json(
      // Deliberately says nothing about which check failed.
      { error: 'Non autorisé / Unauthorized' },
      { status: auth.status },
    )
  }

  const { data: broadcast } = await supabaseAdmin
    .from('broadcasts')
    .select('id, sender_id, sender_type, restaurant_id, title, message, target_city, target_categories, status')
    .eq('id', params.id)
    .maybeSingle()
  if (!broadcast) {
    return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 })
  }

  if (broadcast.status !== 'paid') {
    return NextResponse.json({ error: 'Broadcast not paid', status: broadcast.status }, { status: 409 })
  }

  await supabaseAdmin
    .from('broadcasts')
    .update({ status: 'sending' })
    .eq('id', broadcast.id)

  // Resolve sender name + restaurant name for the message header.
  const { data: sender } = await supabaseAdmin
    .from('customers')
    .select('name')
    .eq('id', broadcast.sender_id)
    .maybeSingle()
  let restaurantName: string | null = null
  if (broadcast.restaurant_id) {
    const { data: r } = await supabaseAdmin
      .from('restaurants')
      .select('name')
      .eq('id', broadcast.restaurant_id)
      .maybeSingle()
    restaurantName = r?.name ?? null
  }

  // Audience — dedup across categories. Track each recipient's language so the
  // broadcast wrapper (header + unsubscribe footer) is localized per recipient.
  const recipients: { phone: string; lang: Lang; customerId: string }[] = []
  const seenCustomerIds = new Set<string>()
  const addSub = (s: { customer_id: string; customers: { phone: string; preferred_language?: string | null } | null }) => {
    if (!s.customers?.phone || seenCustomerIds.has(s.customer_id)) return
    seenCustomerIds.add(s.customer_id)
    recipients.push({ phone: s.customers.phone, lang: normalizeLang(s.customers.preferred_language), customerId: s.customer_id })
  }
  const categories = (broadcast.target_categories as string[] | null) ?? null
  if (!categories) {
    const subs = await findMatchingSubscribers({ city: broadcast.target_city })
    for (const s of subs) addSub(s)
  } else {
    for (const cat of categories) {
      const subs = await findMatchingSubscribers({ city: broadcast.target_city, category: cat })
      for (const s of subs) addSub(s)
    }
  }

  const base = {
    title:       broadcast.title,
    message:     broadcast.message,
    sender_name: sender?.name ?? 'Tchop & Ndjoka',
    restaurant_name: restaurantName,
    sender_type: broadcast.sender_type as 'publisher' | 'restaurant',
  }
  // Render once per language, then map each recipient to their variant.
  const messageByLang: Record<Lang, string> = {
    fr: formatBroadcastMessage(base, 'fr'),
    en: formatBroadcastMessage(base, 'en'),
  }

  const { ok, failed } = await fanoutBatched(
    recipients.map(r => ({ phone: r.phone, message: messageByLang[r.lang], customerId: r.customerId })),
    { context: 'broadcast', relatedId: broadcast.id })

  const finalStatus = ok > 0 || recipients.length === 0 ? 'sent' : 'failed'

  await supabaseAdmin
    .from('broadcasts')
    .update({
      status:          finalStatus,
      recipient_count: recipients.length,
      sent_at:         new Date().toISOString(),
    })
    .eq('id', broadcast.id)

  await writeAudit({
    action:          'broadcast_sent',
    targetType:      'customer',
    targetId:        broadcast.sender_id,
    performedBy:     broadcast.sender_id,
    performedByType: 'system',
    metadata: {
      broadcast_id:    broadcast.id,
      recipient_count: recipients.length,
      ok,
      failed,
      final_status:    finalStatus,
    },
  })

  return NextResponse.json({ ok: true, recipients: recipients.length, sent: ok, failed })
}
