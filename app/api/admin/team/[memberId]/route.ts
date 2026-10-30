import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import bcrypt from 'bcryptjs'
import { TEAM_ROLES, TEAM_STATUSES, MIN_PASSWORD, teamPhone, PHONE_REQUIRED, PASSWORD_SHORT } from '@/lib/adminTeam'

export const dynamic = 'force-dynamic'

// PATCH: edit a member (super_admin only). Body, any of:
//   phone   (+E.164 — gets the login code)
//   role    'admin' | 'moderator'
//   status  'active' | 'suspended' (Désactivé)
//   password  a new TEMPORARY password — changed at their next login
// Not your own account, not another super admin. One audit row per change.
export async function PATCH(req: NextRequest, { params }: { params: { memberId: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'super_admin') {
    return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  }
  if (session.id === params.memberId) {
    return NextResponse.json({ error: 'Vous ne pouvez pas modifier votre propre compte / Cannot modify your own account' }, { status: 400 })
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const { data: before } = await supabaseAdmin
    .from('admin_users').select('email, name, role, status, phone')
    .eq('id', params.memberId).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Membre introuvable / Member not found' }, { status: 404 })
  if (before.role === 'super_admin') {
    return NextResponse.json({ error: 'Un super admin ne se modifie pas ici / A super admin cannot be edited here' }, { status: 403 })
  }

  const update: Record<string, unknown> = {}
  const changes: Array<{ action: string; previous: Record<string, unknown>; next: Record<string, unknown> }> = []
  if ('phone' in body) {
    const phone = teamPhone(body.phone)
    if (!phone) return NextResponse.json({ error: PHONE_REQUIRED, field: 'phone' }, { status: 400 })
    if (phone !== before.phone) { update.phone = phone; changes.push({ action: 'admin_user_phone_changed', previous: { phone: before.phone }, next: { phone } }) }
  }
  if ('role' in body) {
    const role = String(body.role)
    if (!(TEAM_ROLES as readonly string[]).includes(role)) return NextResponse.json({ error: 'Rôle invalide / Invalid role', field: 'role' }, { status: 400 })
    if (role !== before.role) { update.role = role; changes.push({ action: 'admin_user_role_changed', previous: { role: before.role }, next: { role } }) }
  }
  if ('status' in body) {
    const status = String(body.status)
    if (!(TEAM_STATUSES as readonly string[]).includes(status)) return NextResponse.json({ error: 'Statut invalide / Invalid status', field: 'status' }, { status: 400 })
    if (status !== before.status) {
      update.status = status
      changes.push({ action: status === 'suspended' ? 'admin_user_suspended' : 'admin_user_reactivated', previous: { status: before.status }, next: { status } })
    }
  }
  if ('password' in body) {
    const password = typeof body.password === 'string' ? body.password : ''
    if (password.length < MIN_PASSWORD) return NextResponse.json({ error: PASSWORD_SHORT, field: 'password' }, { status: 400 })
    update.password_hash = await bcrypt.hash(password, 12)
    update.must_change_password = true
    changes.push({ action: 'admin_user_password_reset', previous: {}, next: { must_change_password: true } })
  }
  if (!changes.length) return NextResponse.json({ ok: true, changed: [] })

  const { data: member, error } = await supabaseAdmin.from('admin_users').update(update).eq('id', params.memberId)
    .select('id, email, name, role, status, phone, must_change_password, created_at').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  for (const c of changes) {
    await writeAudit({
      action: c.action, targetType: 'admin_user', targetId: params.memberId,
      performedBy: session.id, performedByType: session.role,
      previousData: { email: before.email, ...c.previous }, metadata: c.next,
    })
  }
  return NextResponse.json({ ok: true, member, changed: changes.map(c => c.action) })
}

// DELETE: remove admin user
export async function DELETE(req: NextRequest, { params }: { params: { memberId: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'super_admin') {
    return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  }
  if (session.id === params.memberId) {
    return NextResponse.json({ error: 'Vous ne pouvez pas supprimer votre propre compte / Cannot delete your own account' }, { status: 400 })
  }

  const { data: before } = await supabaseAdmin
    .from('admin_users').select('email, name, role, status, created_at')
    .eq('id', params.memberId).maybeSingle()

  await supabaseAdmin.from('admin_users').delete().eq('id', params.memberId)

  await writeAudit({
    action: 'admin_user_deleted',
    targetType: 'admin_user',
    targetId: params.memberId,
    performedBy: session.id,
    performedByType: session.role,
    previousData: before ?? null,
  })

  return NextResponse.json({ ok: true })
}
