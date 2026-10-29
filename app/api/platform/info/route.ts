import { NextResponse } from 'next/server'
import { getLegalInfo } from '@/lib/legalInfoServer'

export const dynamic = 'force-dynamic'

// GET /api/platform/info (U1) — public legal & contact info for the footer,
// /contact and the legal pages. Only the values that are set.
export async function GET() {
  return NextResponse.json(await getLegalInfo(), { headers: { 'Cache-Control': 'public, max-age=60' } })
}
