import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { scanUrl, type ScanKind } from '@/lib/scanTokens'
import { bookingIdOf } from '@/lib/scanLinks'
import { orderCode, reservationCode } from '@/lib/shortCode'

export const dynamic = 'force-dynamic'

// GET /api/scan/mine?kind=reservation|order|voucher&id=… (Q1)
// The QR link of the logged-in customer's OWN booking, order or claimed
// voucher (customer_vouchers.id) → { url, code }. Anyone else: 404.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  const kind = req.nextUrl.searchParams.get('kind') as ScanKind | null
  const id = req.nextUrl.searchParams.get('id') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'id' }, { status: 400 })
  const notFound = NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })

  try {
    if (kind === 'reservation') {
      const { data: r } = await supabaseAdmin.from('event_reservations')
        .select('id, customer_id, reservation_code').eq('id', id).maybeSingle()
      if (!r || r.customer_id !== session.id) return notFound
      const bookingId = await bookingIdOf(r.id)
      const { data: first } = await supabaseAdmin.from('event_reservations').select('id, reservation_code').eq('id', bookingId).maybeSingle()
      return NextResponse.json({ url: await scanUrl('reservation', bookingId), code: reservationCode(first ?? r) }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (kind === 'order') {
      const { data: o } = await supabaseAdmin.from('orders').select('id, customer_id').eq('id', id).maybeSingle()
      if (!o || o.customer_id !== session.id) return notFound
      return NextResponse.json({ url: await scanUrl('order', o.id), code: orderCode(o.id) }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (kind === 'voucher') {
      const { data: cv } = await supabaseAdmin.from('customer_vouchers')
        .select('id, customer_id, vouchers!customer_vouchers_voucher_id_fkey(code)').eq('id', id).maybeSingle()
      if (!cv || cv.customer_id !== session.id) return notFound
      const code = (cv.vouchers as unknown as { code?: string } | null)?.code ?? orderCode(cv.id)
      return NextResponse.json({ url: await scanUrl('voucher', cv.id), code }, { headers: { 'Cache-Control': 'no-store' } })
    }
  } catch (e) {
    console.error('[scan/mine]', (e as Error).message)
    return NextResponse.json({ error: 'QR indisponible / QR unavailable' }, { status: 503 })
  }
  return NextResponse.json({ error: 'kind' }, { status: 400 })
}
