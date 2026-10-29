import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'

export const dynamic = 'force-dynamic'

// /api/restaurants/[id]/contact-click (N4a)
// POST { kind: 'whatsapp' | 'call' }  public — a tap on "Commander sur
//      WhatsApp" / "Appeler" on the restaurant page (sent with
//      navigator.sendBeacon). The same customer tapping again within a
//      minute counts once.
// GET  owner / manager / admin → { whatsapp, call } over the last 30 days,
//      so we can show a restaurant how many customers we send.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let kind = ''
  try { kind = String((JSON.parse(await req.text()) as { kind?: unknown }).kind ?? '') } catch { /* bad body */ }
  if (kind !== 'whatsapp' && kind !== 'call') return NextResponse.json({ error: 'kind' }, { status: 400 })
  const { data: rest } = await supabaseAdmin.from('restaurants').select('id').eq('id', params.id).is('deleted_at', null).maybeSingle()
  if (!rest) return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
  const session = getSessionFromRequest(req)
  const customerId = session?.role === 'customer' ? session.id : null
  if (customerId) {
    const { count } = await supabaseAdmin.from('restaurant_contact_clicks').select('id', { count: 'exact', head: true })
      .eq('restaurant_id', params.id).eq('customer_id', customerId).eq('kind', kind)
      .gt('created_at', new Date(Date.now() - 60_000).toISOString())
    if ((count ?? 0) > 0) return NextResponse.json({ ok: true, counted: false })
  }
  await supabaseAdmin.from('restaurant_contact_clicks').insert({ restaurant_id: params.id, kind, customer_id: customerId })
  return NextResponse.json({ ok: true, counted: true })
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const count = async (kind: string) => (await supabaseAdmin.from('restaurant_contact_clicks')
    .select('id', { count: 'exact', head: true }).eq('restaurant_id', params.id).eq('kind', kind).gt('created_at', since)).count ?? 0
  const [whatsapp, call] = await Promise.all([count('whatsapp'), count('call')])
  return NextResponse.json({ whatsapp, call, days: 30 }, { headers: { 'Cache-Control': 'no-store' } })
}
