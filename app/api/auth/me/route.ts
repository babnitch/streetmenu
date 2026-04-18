import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session) {
    return NextResponse.json({ user: null }, { status: 200 })
  }
  return NextResponse.json({ user: session })
}
