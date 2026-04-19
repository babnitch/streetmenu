import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { normalizePhone } from '@/lib/phone'

export const dynamic = 'force-dynamic'

// Returns whether a customer row exists for the given phone.
// Accepts the phone via either ?phone=… query (GET) or JSON body (POST);
// GET is the canonical form for idempotent lookups.
async function handle(phone: string): Promise<NextResponse> {
  const normalized = normalizePhone(phone)
  if (!normalized) {
    return NextResponse.json({ error: 'Phone required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('customers')
    .select('name, status, deleted_at')
    .eq('phone', normalized)
    .maybeSingle()

  if (error) {
    console.error('[check-phone] supabase error:', error.message)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }

  // Treat soft-deleted customers as non-existing so the user can re-register.
  const isDeleted = !!data?.deleted_at || data?.status === 'deleted'
  const exists = !!data && !isDeleted

  return NextResponse.json({
    exists,
    name: exists ? data?.name ?? null : null,
    normalizedPhone: normalized,
  })
}

export async function GET(req: NextRequest) {
  return handle(req.nextUrl.searchParams.get('phone') ?? '')
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  return handle(typeof body.phone === 'string' ? body.phone : '')
}
