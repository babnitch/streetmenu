import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { validateNickname, nicknameCooldownDaysRemaining, NICKNAME_REJECT_MESSAGES } from '@/lib/nickname'

export const dynamic = 'force-dynamic'

// POST /api/auth/nickname { nickname }
// Sets or updates the caller's nickname. Enforces the 30-day cooldown
// from `customers.nickname_updated_at` — except when the user is setting
// a nickname for the first time (updated_at IS NULL), which is always
// allowed.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const check = validateNickname(String(body?.nickname ?? ''))
  if (!check.ok) {
    return NextResponse.json({ error: NICKNAME_REJECT_MESSAGES[check.reason], reason: check.reason }, { status: 400 })
  }

  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, nickname, nickname_updated_at')
    .eq('id', session.id)
    .maybeSingle()
  if (!customer) {
    return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })
  }

  // Cooldown only kicks in for *updates* — the first set should never block
  // a customer who's just been prompted to choose one before posting a
  // comment.
  const cooldownDays = customer.nickname_updated_at
    ? nicknameCooldownDaysRemaining(customer.nickname_updated_at)
    : 0
  if (cooldownDays > 0 && customer.nickname !== check.value) {
    return NextResponse.json({
      error: NICKNAME_REJECT_MESSAGES.cooldown,
      reason: 'cooldown',
      days_remaining: cooldownDays,
    }, { status: 409 })
  }

  // Same value: no-op write that still returns ok=true so clients don't
  // need to special-case.
  if (customer.nickname === check.value) {
    return NextResponse.json({ ok: true, nickname: check.value, updated: false })
  }

  // Uniqueness — we don't enforce it at the DB level (the column is
  // nullable and adding a partial unique index across millions of rows
  // is overkill at this scale). Soft check here lets duplicates through
  // but warns the user.
  const { data: collision } = await supabaseAdmin
    .from('customers')
    .select('id')
    .eq('nickname', check.value)
    .neq('id', session.id)
    .limit(1)
    .maybeSingle()
  // Not a hard error — multiple users CAN share a nickname. Just hint.
  const collisionHint = !!collision

  const { error: updErr } = await supabaseAdmin
    .from('customers')
    .update({ nickname: check.value, nickname_updated_at: new Date().toISOString() })
    .eq('id', session.id)

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    nickname: check.value,
    updated: true,
    collision_hint: collisionHint,
  })
}
