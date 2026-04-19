import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

function buildWelcomeMessage(restaurantName: string): string {
  return [
    `✅ Votre restaurant *${restaurantName}* a été approuvé sur Ndjoka & Tchop! 🎉`,
    ``,
    `Vous recevrez désormais les notifications de commandes ici.`,
    ``,
    `Envoyez "aide" pour voir les commandes disponibles.`,
    ``,
    `/ Your restaurant *${restaurantName}* has been approved! You'll now receive order notifications here. Send "help" for available commands.`,
  ].join('\n')
}

// Owner phones from both restaurants.whatsapp (direct) and active owner rows
// in restaurant_team. Deduped. Keeps this approval route self-contained rather
// than importing the ordering module's broader fan-out helper (which includes
// managers and is scoped to a different use case).
async function ownerRecipients(restaurantId: string, directWhatsapp: string | null): Promise<string[]> {
  const phones = new Set<string>()
  if (directWhatsapp) phones.add(directWhatsapp)

  const { data: team } = await supabaseAdmin
    .from('restaurant_team')
    .select('customers(phone)')
    .eq('restaurant_id', restaurantId)
    .eq('role', 'owner')
    .eq('status', 'active')

  for (const m of team ?? []) {
    const c = m.customers as unknown as { phone: string } | null
    if (c?.phone) phones.add(c.phone)
  }
  return Array.from(phones)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  // Read current state so we can (a) skip welcome if already active,
  // (b) use the saved name in the welcome message, (c) include whatsapp
  // in the recipient set without a second query.
  const { data: before, error: readErr } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, status, whatsapp')
    .eq('id', params.id)
    .maybeSingle()

  if (readErr || !before) {
    return NextResponse.json({ error: readErr?.message ?? 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
  }

  const wasAlreadyActive = before.status === 'active'

  const { error } = await supabaseAdmin
    .from('restaurants')
    .update({ status: 'active', is_active: true })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action: 'restaurant_approved',
    targetType: 'restaurant',
    targetId: params.id,
    performedBy: session.id,
    performedByType: session.role,
    previousData: { status: before.status },
  })

  // Welcome message on a genuine transition only. If the admin re-approves
  // an already-active restaurant, no message is sent (prevents spam on
  // accidental double-clicks). The route still returns ok — the UPDATE is
  // idempotent.
  if (!wasAlreadyActive) {
    const recipients = await ownerRecipients(params.id, before.whatsapp ?? null)
    console.log(`[approve] restaurant=${params.id} previousStatus=${before.status} recipients=${JSON.stringify(recipients)}`)

    if (recipients.length === 0) {
      console.warn(`[approve] no owner phones for restaurant ${params.id}. Check restaurants.whatsapp and owner rows in restaurant_team.`)
    } else {
      const msg = buildWelcomeMessage(before.name)
      const results = await Promise.allSettled(recipients.map(p => sendWhatsApp(p, msg)))
      results.forEach((r, i) => {
        const to = recipients[i]
        if (r.status === 'rejected') {
          console.error(`[approve] send rejected to=${to} reason=${String((r as PromiseRejectedResult).reason)}`)
        } else {
          const v = r.value
          console.log(`[approve] welcome to=${to} ok=${v.ok} status=${v.status} sid=${v.sid ?? '-'} twilioStatus=${v.twilioStatus ?? '-'}${v.error ? ` error=${v.error.slice(0, 120)}` : ''}`)
        }
      })
    }
  }

  return NextResponse.json({ ok: true, welcomedOwners: !wasAlreadyActive })
}
