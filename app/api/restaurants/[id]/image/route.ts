import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// POST { image_url } — owner updates their restaurant's image_url.
// The client uploads the file to Supabase Storage itself (the `photos`
// bucket is open for anon uploads, matching /admin and /join) and
// then hits this route to persist the resulting public URL.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: ownerEntry } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()
  if (!ownerEntry || ownerEntry.role !== 'owner') {
    return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
  }

  const { image_url } = await req.json()
  if (typeof image_url !== 'string' || !image_url.startsWith('http')) {
    return NextResponse.json({ error: 'URL invalide / Invalid URL' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('restaurants')
    .update({ image_url })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, image_url })
}
