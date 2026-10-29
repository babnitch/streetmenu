import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rateLimit'
import { sanitizeText } from '@/lib/sanitize'
import { createDeletionRequest } from '@/lib/dataDeletion'

export const dynamic = 'force-dynamic'

// POST /api/data-deletion { phone, reason? } (U2) — the public form on
// /suppression-donnees. Creates a request for the admin. The answer is the
// same whether or not the number has an account. 5 per hour per IP.
export async function POST(req: NextRequest) {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local'
  const hit = rateLimit({ key: `deletion:${ip}`, max: 5, windowMs: 3_600_000 })
  if (hit) return NextResponse.json({ error: hit.message }, { status: 429 })
  const body = await req.json().catch(() => ({})) as { phone?: unknown; reason?: unknown }
  const r = await createDeletionRequest(typeof body.phone === 'string' ? body.phone : '', sanitizeText(body.reason, 500) || null, 'web')
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
