import { NextResponse } from 'next/server'
import { getRefData } from '@/lib/refDataServer'

export const dynamic = 'force-dynamic'

// GET /api/ref — the reference lists for the browser: visible AND hidden
// values (hidden ones only to label items that already use them; pickers
// filter on `visible`). Public, cached 60 s.
export async function GET() {
  const values = await getRefData()
  return NextResponse.json({ values }, { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=60' } })
}
