import { NextResponse } from 'next/server'
import { testGuardPrefix } from '@/lib/testGuard'

export const dynamic = 'force-dynamic'

// GET /api/internal/test-guard — lets the test runner check, before any API
// suite, that the local server refuses sends to non-test numbers
// (TEST_ONLY_PHONE_PREFIX). Not served in production.
export async function GET() {
  if (process.env.NODE_ENV === 'production') return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ prefix: testGuardPrefix() })
}
