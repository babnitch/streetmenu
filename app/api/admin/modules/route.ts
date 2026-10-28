import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { restaurantModules, organizerModules, setRestaurantModules, setOrganizerModules } from '@/lib/modulesServer'

export const dynamic = 'force-dynamic'

// Admin → a pro's modules (M1). super_admin / admin only.
//
// GET ?subject=restaurant|organizer&id=…   → { modules }
// PUT { subject, id, modules: string[] }    → the full new list, validated
//     (names, dependencies), audited before → after.
const UUID = /^[0-9a-f-]{36}$/i

function admin(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && ['super_admin', 'admin'].includes(s.role) ? s : null
}

export async function GET(req: NextRequest) {
  if (!admin(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const subject = req.nextUrl.searchParams.get('subject')
  const id = req.nextUrl.searchParams.get('id') ?? ''
  if (!UUID.test(id) || (subject !== 'restaurant' && subject !== 'organizer')) {
    return NextResponse.json({ error: 'subject, id' }, { status: 400 })
  }
  const modules = subject === 'restaurant' ? await restaurantModules(id) : await organizerModules(id)
  return NextResponse.json({ modules }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(req: NextRequest) {
  const session = admin(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!UUID.test(id) || (body?.subject !== 'restaurant' && body?.subject !== 'organizer')) {
    return NextResponse.json({ error: 'subject, id' }, { status: 400 })
  }
  const actor = { id: session.id, type: session.role }
  const r = body.subject === 'restaurant'
    ? await setRestaurantModules(id, body.modules, actor)
    : await setOrganizerModules(id, body.modules, actor)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true, modules: r.after })
}
