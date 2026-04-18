import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// POST { currentPassword, newPassword } — verify current with bcrypt, then
// replace the stored hash. Only the currently-authenticated admin can
// change their own password.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { currentPassword, newPassword } = await req.json()
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return NextResponse.json({ error: 'Champs manquants / Missing fields' }, { status: 400 })
  }
  if (newPassword.length < 8) {
    return NextResponse.json(
      { error: 'Le nouveau mot de passe doit contenir au moins 8 caractères / New password must be at least 8 characters' },
      { status: 400 },
    )
  }

  const { data: admin, error: fetchErr } = await supabaseAdmin
    .from('admin_users')
    .select('id, password_hash')
    .eq('id', session.id)
    .maybeSingle()

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!admin)  return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })

  const ok = await bcrypt.compare(currentPassword, admin.password_hash)
  if (!ok) {
    return NextResponse.json(
      { error: 'Mot de passe actuel incorrect / Current password is incorrect' },
      { status: 403 },
    )
  }

  const newHash = await bcrypt.hash(newPassword, 12)
  const { error: updErr } = await supabaseAdmin
    .from('admin_users')
    .update({ password_hash: newHash })
    .eq('id', session.id)

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
