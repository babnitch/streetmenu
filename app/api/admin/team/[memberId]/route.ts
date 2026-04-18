import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// PATCH: suspend or reactivate
export async function PATCH(req: NextRequest, { params }: { params: { memberId: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'super_admin') {
    return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  }
  if (session.id === params.memberId) {
    return NextResponse.json({ error: 'Vous ne pouvez pas modifier votre propre compte / Cannot modify your own account' }, { status: 400 })
  }

  const { status } = await req.json()
  if (!['active', 'suspended'].includes(status)) {
    return NextResponse.json({ error: 'Statut invalide / Invalid status' }, { status: 400 })
  }

  await supabaseAdmin.from('admin_users').update({ status }).eq('id', params.memberId)
  return NextResponse.json({ ok: true })
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

  await supabaseAdmin.from('admin_users').delete().eq('id', params.memberId)
  return NextResponse.json({ ok: true })
}
