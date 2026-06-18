import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { normalizeLang, type Lang } from '@/lib/whatsapp'
import {
  findMatchingSubscribers,
  fanoutBatched,
  formatBroadcastMessage,
} from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

// POST /api/broadcasts/[id]/send
// Called by the PawaPay webhook (and as a self-serve retry) once the
// deposit completes. Loads the broadcast, queries the audience, fans out
// over WhatsApp. Idempotent — status must be 'paid' to fire; otherwise
// returns 409.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
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
  const recipients: { phone: string; lang: Lang }[] = []
  const seenCustomerIds = new Set<string>()
  const addSub = (s: { customer_id: string; customers: { phone: string; preferred_language?: string | null } | null }) => {
    if (!s.customers?.phone || seenCustomerIds.has(s.customer_id)) return
    seenCustomerIds.add(s.customer_id)
    recipients.push({ phone: s.customers.phone, lang: normalizeLang(s.customers.preferred_language) })
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
    recipients.map(r => ({ phone: r.phone, message: messageByLang[r.lang] })))

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
