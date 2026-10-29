import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { SITE_URL } from '@/lib/siteLinks'

export const dynamic = 'force-dynamic'

// POST /api/admin/restaurants/[id]/welcome (N3) — the owner's welcome
// message, sent only when the admin taps "Envoyer le message de bienvenue"
// (never automatically on a change of owner). One WhatsApp to the owner.
// Admin-only (super_admin | admin).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const { data: rest } = await supabaseAdmin.from('restaurants').select('id, name').eq('id', params.id).maybeSingle()
  if (!rest) return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
  const { data: row } = await supabaseAdmin.from('restaurant_team')
    .select('customer_id, customers!restaurant_team_customer_id_fkey(phone)')
    .eq('restaurant_id', rest.id).eq('role', 'owner').eq('status', 'active')
    .limit(1).maybeSingle()
  const phone = (row?.customers as unknown as { phone?: string } | null)?.phone
  if (!phone) return NextResponse.json({ error: 'Pas de propriétaire / No owner' }, { status: 409 })

  const lang = await getLangByPhone(phone)
  const sent = await sendWhatsApp(phone, pickLang(
    `👋 Bienvenue sur Tchop & Ndjoka !\n\nVous êtes maintenant le propriétaire de *${rest.name}*. ` +
    `Connectez-vous avec ce numéro pour gérer votre restaurant :\n${SITE_URL}/pro\n\nEnvoyez "aide" pour voir les commandes WhatsApp.`,
    `👋 Welcome to Tchop & Ndjoka!\n\nYou are now the owner of *${rest.name}*. ` +
    `Log in with this number to manage your restaurant:\n${SITE_URL}/pro\n\nSend "help" for the WhatsApp commands.`,
    lang,
  ), { context: 'account_notice', relatedId: rest.id, customerId: row?.customer_id })

  await writeAudit({
    action: 'owner_welcome_sent', targetType: 'restaurant', targetId: rest.id,
    performedBy: session.id, performedByType: session.role, metadata: { to: phone, ok: sent.ok },
  })
  // A refused send is logged and, when the cause is temporary, retried
  // automatically (lib/messageRetry.ts) — the panel says which.
  return NextResponse.json({ ok: true, sent: sent.ok })
}
