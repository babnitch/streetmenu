import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { writeAudit } from '@/lib/audit'
import { listMenuFiles, addMenuFile } from '@/lib/menuFilesServer'
import { restaurantModules } from '@/lib/modulesServer'
import { orderPhones } from '@/lib/managedRestaurant'

export const dynamic = 'force-dynamic'

// /api/restaurants/[id]/menu-files (N4a) — the menu as photos or a PDF.
//
// GET   public: { files, order_whatsapp } — order_whatsapp is the number
//       "Commander sur WhatsApp" opens (a managed restaurant taking orders:
//       its first order number; otherwise its WhatsApp / phone).
// POST  { path }   owner / manager / admin: record a file just uploaded to
//       Storage with a signed URL (…/upload-url). Checked: folder, type,
//       size, 5 files max, one PDF max.
// PATCH { order: [fileId…] }   owner / manager / admin: new order.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { data: rest } = await supabaseAdmin.from('restaurants')
    .select('id, whatsapp, phone, managed_by_platform').eq('id', params.id).maybeSingle()
  if (!rest) return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
  const files = await listMenuFiles(params.id)
  let orderWhatsapp = rest.whatsapp || rest.phone || null
  if (rest.managed_by_platform && (await restaurantModules(params.id)).includes('orders')) {
    orderWhatsapp = (await orderPhones(params.id))[0] ?? orderWhatsapp
  }
  return NextResponse.json({ files, order_whatsapp: orderWhatsapp }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const session = getSessionFromRequest(req)!
  const body = await req.json().catch(() => ({})) as { path?: unknown }
  const r = await addMenuFile(params.id, typeof body.path === 'string' ? body.path : '', session.role === 'customer' ? session.id : null)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  await writeAudit({
    action: 'menu_file_added', targetType: 'restaurant', targetId: params.id,
    performedBy: session.id, performedByType: session.role, metadata: { file_id: r.file.id, kind: r.file.kind, bytes: r.file.bytes, via: 'web' },
  })
  return NextResponse.json({ ok: true, file: r.file, files: await listMenuFiles(params.id) })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const body = await req.json().catch(() => ({})) as { order?: unknown }
  const order = Array.isArray(body.order) ? body.order.filter((x): x is string => typeof x === 'string') : []
  const files = await listMenuFiles(params.id)
  if (order.length !== files.length || !files.every(f => order.includes(f.id))) {
    return NextResponse.json({ error: 'Ordre invalide / Invalid order' }, { status: 400 })
  }
  await Promise.all(order.map((id, i) => supabaseAdmin.from('restaurant_menu_files').update({ position: i }).eq('id', id).eq('restaurant_id', params.id)))
  return NextResponse.json({ ok: true, files: await listMenuFiles(params.id) })
}
