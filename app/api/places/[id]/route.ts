import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { PUBLIC_PLACE_COLUMNS } from '@/lib/places'

export const dynamic = 'force-dynamic'

// GET /api/places/[id] (I4) — one published place, public fields only. An
// admin also sees a pending / hidden one (to preview it).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const { data } = await supabaseAdmin.from('places').select(`${PUBLIC_PLACE_COLUMNS}, status`).eq('id', params.id).maybeSingle()
  const s = getSessionFromRequest(req)
  const admin = !!s && ['super_admin', 'admin', 'moderator'].includes(s.role)
  if (!data || (data.status !== 'active' && !admin)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  return NextResponse.json({ place: data }, { headers: { 'Cache-Control': 'no-store' } })
}
