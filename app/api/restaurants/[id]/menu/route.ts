import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { sanitizeText } from '@/lib/sanitize'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/menu — create a menu item.
//
// Replaces a browser-side anon-key INSERT into menu_items. The anon key is
// public and the table's write policies are WITH CHECK (true), so that path
// let anyone write any restaurant's menu. Mirrors the WhatsApp flow, which
// already writes server-side with supabaseAdmin.
//
// Authorization: owner|manager of THIS restaurant, or admin — see
// lib/vendorAccess.ts. Staff excluded (menu is read-only for them).
//
// `restaurant_id` comes from the URL, never the body: the restaurant that
// was authorized and the restaurant written to are the same value by
// construction.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const session = getSessionFromRequest(req)!

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Requête invalide / Invalid request' }, { status: 400 })
  }

  const name  = sanitizeText(body.name, 120)
  const price = Number(body.price)
  if (!name) {
    return NextResponse.json({ error: 'Nom requis / Name required' }, { status: 400 })
  }
  if (!Number.isFinite(price) || price < 0) {
    return NextResponse.json({ error: 'Prix invalide / Invalid price' }, { status: 400 })
  }

  // Built literally — body.restaurant_id (which the form still sends) and any
  // other key simply have no path in.
  const row = {
    restaurant_id:    params.id,
    name,
    description:      sanitizeText(body.description, 500),
    price,
    // Free text on purpose: legacy rows and WhatsApp-created items carry
    // values outside the dashboard's fixed list, and the customer page
    // derives its category pills from whatever is in the data.
    category:         sanitizeText(body.category, 80) || 'Autre',
    photo_url:        typeof body.photo_url === 'string' ? body.photo_url : '',
    is_available:     typeof body.is_available === 'boolean' ? body.is_available : true,
    is_daily_special: typeof body.is_daily_special === 'boolean' ? body.is_daily_special : false,
  }

  const { data, error } = await supabaseAdmin
    .from('menu_items').insert(row).select().single()

  if (error || !data) {
    console.error('[restaurants/[id]/menu POST] insert failed:', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Erreur serveur / Server error' }, { status: 500 })
  }

  await writeAudit({
    action:          'menu_item_created',
    targetType:      'menu_item',
    targetId:        data.id,
    performedBy:     session.id,
    performedByType: session.role === 'customer' ? 'vendor' : session.role,
    metadata:        { restaurant_id: params.id, name: row.name, price: row.price },
  })

  return NextResponse.json({ ok: true, item: data })
}
