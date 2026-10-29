import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { writeAudit } from '@/lib/audit'
import { normalizePhone } from '@/lib/phone'
import { sanitizeText } from '@/lib/sanitize'
import { findOrCreateAccount } from '@/lib/ownerAccount'
import { listRiders } from '@/lib/riders'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { SITE_URL } from '@/lib/siteLinks'

export const dynamic = 'force-dynamic'

// /api/restaurants/[id]/riders (Q5) — the restaurant's riders (when its
// "Livreurs" setting is "Mes livreurs utilisent l'app").
// GET                      the list
// POST   { phone, name? }  add (existing account or a new one) — one WhatsApp
// DELETE { rider_id }      remove; their open assignments are cleared
// Owner / manager / admin.

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  return NextResponse.json({ riders: await listRiders(params.id) }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const session = getSessionFromRequest(req)!
  const { data: rest } = await supabaseAdmin.from('restaurants').select('id, name, city, riders_mode').eq('id', params.id).maybeSingle()
  if (!rest) return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
  if (rest.riders_mode !== 'app') {
    return NextResponse.json({ error: 'Activez d\'abord « Mes livreurs utilisent l\'app » / First switch on "My riders use the app"' }, { status: 409 })
  }
  const body = await req.json().catch(() => ({})) as { phone?: unknown; name?: unknown }
  const phone = normalizePhone(typeof body.phone === 'string' ? body.phone : '')
  const acc = await findOrCreateAccount(phone, sanitizeText(body.name, 60) || 'Livreur', rest.city, { id: session.id, type: session.role }, 'rider')
  if (!acc.ok) return NextResponse.json({ error: acc.error, field: 'phone' }, { status: acc.status })
  const { data: existing } = await supabaseAdmin.from('restaurant_riders').select('status')
    .eq('restaurant_id', rest.id).eq('customer_id', acc.account.id).maybeSingle()
  if (existing?.status === 'active') return NextResponse.json({ error: 'Déjà livreur ici / Already a rider here' }, { status: 409 })
  const { error } = await supabaseAdmin.from('restaurant_riders').upsert({
    restaurant_id: rest.id, customer_id: acc.account.id, status: 'active',
    added_by: session.role === 'customer' ? session.id : null,
  }, { onConflict: 'restaurant_id,customer_id' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await writeAudit({
    action: 'rider_added', targetType: 'restaurant', targetId: rest.id,
    performedBy: session.id, performedByType: session.role === 'customer' ? 'vendor' : session.role,
    metadata: { customer_id: acc.account.id, phone: acc.account.phone, account_created: acc.created },
  })
  const lang = await getLangByPhone(acc.account.phone)
  await sendWhatsApp(acc.account.phone, pickLang(
    `🛵 Vous êtes livreur pour *${rest.name}* sur Tchop & Ndjoka.\n\nVos livraisons (connectez-vous avec ce numéro) :\n${SITE_URL}/livraisons`,
    `🛵 You are a rider for *${rest.name}* on Tchop & Ndjoka.\n\nYour deliveries (log in with this number):\n${SITE_URL}/livraisons`,
    lang,
  ), { context: 'account_notice', relatedId: rest.id, customerId: acc.account.id })
  return NextResponse.json({ ok: true, riders: await listRiders(rest.id) })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const session = getSessionFromRequest(req)!
  const body = await req.json().catch(() => ({})) as { rider_id?: unknown }
  const riderId = String(body.rider_id ?? '')
  const { data } = await supabaseAdmin.from('restaurant_riders').update({ status: 'removed' })
    .eq('id', riderId).eq('restaurant_id', params.id).eq('status', 'active').select('id')
  if (!data || data.length === 0) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  await supabaseAdmin.from('orders').update({ rider_id: null }).eq('rider_id', riderId)
    .in('status', ['confirmed', 'preparing', 'ready', 'out_for_delivery'])
  await writeAudit({
    action: 'rider_removed', targetType: 'restaurant', targetId: params.id,
    performedBy: session.id, performedByType: session.role === 'customer' ? 'vendor' : session.role, metadata: { rider_id: riderId },
  })
  return NextResponse.json({ ok: true, riders: await listRiders(params.id) })
}
