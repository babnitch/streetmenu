import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { sanitizeText } from '@/lib/sanitize'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH  /api/restaurants/[id]/menu/[itemId] — update, incl. the availability toggle
// DELETE /api/restaurants/[id]/menu/[itemId] — remove an item
//
// Replaces browser-side anon-key UPDATE/DELETE on menu_items.
//
// Authorization: owner|manager of THIS restaurant, or admin — see
// lib/vendorAccess.ts. Staff excluded.
//
// Cross-restaurant guard: the row is read back matching BOTH the item id AND
// the restaurant id from the URL, and every write repeats both filters. An
// item id belonging to another restaurant returns 404 — the authorized
// restaurant is the only one reachable.

async function loadScopedItem(restaurantId: string, itemId: string) {
  return supabaseAdmin
    .from('menu_items')
    .select('id, restaurant_id, name, price, is_available')
    .eq('id', itemId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; itemId: string } },
) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const session = getSessionFromRequest(req)!

  const { data: before, error: readErr } = await loadScopedItem(params.id, params.itemId)
  if (readErr) {
    console.error('[menu PATCH] lookup failed:', readErr.message)
    return NextResponse.json({ error: readErr.message }, { status: 500 })
  }
  if (!before) {
    return NextResponse.json({ error: 'Article introuvable / Item not found' }, { status: 404 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Requête invalide / Invalid request' }, { status: 400 })
  }

  // Partial by design: the availability toggle sends only is_available, the
  // editor sends the full set. Only keys actually present are written, and
  // the object is built literally so restaurant_id / id can't be reassigned.
  const updates: Record<string, unknown> = {}

  if ('name' in body) {
    const name = sanitizeText(body.name, 120)
    if (!name) return NextResponse.json({ error: 'Nom requis / Name required' }, { status: 400 })
    updates.name = name
  }
  if ('price' in body) {
    const price = Number(body.price)
    if (!Number.isFinite(price) || price < 0) {
      return NextResponse.json({ error: 'Prix invalide / Invalid price' }, { status: 400 })
    }
    updates.price = price
  }
  if ('description' in body) updates.description = sanitizeText(body.description, 500)
  if ('category' in body)    updates.category    = sanitizeText(body.category, 80) || 'Autre'
  if ('photo_url' in body)   updates.photo_url   = typeof body.photo_url === 'string' ? body.photo_url : ''
  if ('is_available' in body) {
    if (typeof body.is_available !== 'boolean') {
      return NextResponse.json({ error: 'is_available must be boolean' }, { status: 400 })
    }
    updates.is_available = body.is_available
  }
  if ('is_daily_special' in body) {
    if (typeof body.is_daily_special !== 'boolean') {
      return NextResponse.json({ error: 'is_daily_special must be boolean' }, { status: 400 })
    }
    updates.is_daily_special = body.is_daily_special
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Aucune modification / No changes' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('menu_items')
    .update(updates)
    .eq('id', params.itemId)
    .eq('restaurant_id', params.id)
    .select()
    .single()

  if (error || !data) {
    console.error('[menu PATCH] update failed:', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Erreur serveur / Server error' }, { status: 500 })
  }

  await writeAudit({
    action:          'menu_item_updated',
    targetType:      'menu_item',
    targetId:        params.itemId,
    performedBy:     session.id,
    performedByType: session.role === 'customer' ? 'vendor' : session.role,
    previousData:    { name: before.name, price: before.price, is_available: before.is_available },
    metadata:        { restaurant_id: params.id, changed: Object.keys(updates) },
  })

  return NextResponse.json({ ok: true, item: data })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; itemId: string } },
) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const session = getSessionFromRequest(req)!

  const { data: before, error: readErr } = await loadScopedItem(params.id, params.itemId)
  if (readErr) {
    console.error('[menu DELETE] lookup failed:', readErr.message)
    return NextResponse.json({ error: readErr.message }, { status: 500 })
  }
  if (!before) {
    return NextResponse.json({ error: 'Article introuvable / Item not found' }, { status: 404 })
  }

  const { error } = await supabaseAdmin
    .from('menu_items')
    .delete()
    .eq('id', params.itemId)
    .eq('restaurant_id', params.id)

  if (error) {
    console.error('[menu DELETE] delete failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await writeAudit({
    action:          'menu_item_deleted',
    targetType:      'menu_item',
    targetId:        params.itemId,
    performedBy:     session.id,
    performedByType: session.role === 'customer' ? 'vendor' : session.role,
    previousData:    { name: before.name, price: before.price },
    metadata:        { restaurant_id: params.id },
  })

  return NextResponse.json({ ok: true })
}
