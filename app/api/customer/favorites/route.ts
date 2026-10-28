import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// The customer's favourite restaurants (V4). Customer session only.
//
// GET                    → { favorites: [{ restaurant_id, created_at, restaurant: {…} }] }
// GET ?restaurant_id=…   → { favorite: boolean }
// POST   { restaurant_id } → adds it (idempotent)
// DELETE ?restaurant_id=…  → removes it (idempotent)
//
// customer_favorites is server-only (RLS on, no policies).

const UUID = /^[0-9a-f-]{36}$/i

function customerId(req: NextRequest): string | null {
  const s = getSessionFromRequest(req)
  return s?.role === 'customer' ? s.id : null
}
const unauthorized = () => NextResponse.json({ error: 'Connectez-vous / Log in' }, { status: 401 })

export async function GET(req: NextRequest) {
  const me = customerId(req)
  if (!me) return unauthorized()
  const rid = req.nextUrl.searchParams.get('restaurant_id')
  if (rid) {
    if (!UUID.test(rid)) return NextResponse.json({ error: 'restaurant_id' }, { status: 400 })
    const { data } = await supabaseAdmin.from('customer_favorites')
      .select('restaurant_id').eq('customer_id', me).eq('restaurant_id', rid).maybeSingle()
    return NextResponse.json({ favorite: !!data }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const { data, error } = await supabaseAdmin.from('customer_favorites')
    .select('restaurant_id, created_at, restaurant:restaurants!customer_favorites_restaurant_id_fkey(id, name, city, neighborhood, cuisine_type, image_url, logo_url)')
    .eq('customer_id', me).order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ favorites: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const me = customerId(req)
  if (!me) return unauthorized()
  const body = await req.json().catch(() => ({}))
  const rid = typeof body?.restaurant_id === 'string' ? body.restaurant_id : ''
  if (!UUID.test(rid)) return NextResponse.json({ error: 'restaurant_id' }, { status: 400 })
  const { data: rest } = await supabaseAdmin.from('restaurants')
    .select('id').eq('id', rid).is('deleted_at', null).maybeSingle()
  if (!rest) return NextResponse.json({ error: 'Restaurant introuvable / not found' }, { status: 404 })
  const { error } = await supabaseAdmin.from('customer_favorites')
    .upsert({ customer_id: me, restaurant_id: rid }, { onConflict: 'customer_id,restaurant_id', ignoreDuplicates: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, favorite: true })
}

export async function DELETE(req: NextRequest) {
  const me = customerId(req)
  if (!me) return unauthorized()
  const rid = req.nextUrl.searchParams.get('restaurant_id') ?? ''
  if (!UUID.test(rid)) return NextResponse.json({ error: 'restaurant_id' }, { status: 400 })
  const { error } = await supabaseAdmin.from('customer_favorites')
    .delete().eq('customer_id', me).eq('restaurant_id', rid)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, favorite: false })
}
