import { NextResponse } from 'next/server'
import { getPlatformStatus } from '@/lib/platformSwitch'

export const dynamic = 'force-dynamic'

// GET /api/platform/status → { restaurants, events } (M6). Public: pages use
// it to show "temporairement indisponible" when a side is switched off.
export async function GET() {
  return NextResponse.json(await getPlatformStatus(), { headers: { 'Cache-Control': 'no-store' } })
}
