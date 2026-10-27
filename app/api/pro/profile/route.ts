import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sanitizeText } from '@/lib/sanitize'
import { samePhone } from '@/lib/phone'
import { normalizeTypedPhone, detectCountry, getCountryFromCity } from '@/lib/phoneValidation'

export const dynamic = 'force-dynamic'

// GET / PATCH /api/pro/profile — the logged-in customer's Pro profile
// (supabase-pro-profile.sql):
//   pro_name          organiser / association name; pre-fills new events
//   pro_notify_phone  extra number for event notifications (+E.164)
//
// PATCH body: any of { pro_name, pro_notify_phone }; '' or null clears.
// The extra number is accepted however it is typed (normalizeTypedPhone),
// with the account's own country assumed when it has no dial code.

const COLUMNS = 'phone, city, pro_name, pro_notify_phone'

type Row = { phone: string; city: string | null; pro_name: string | null; pro_notify_phone: string | null }

function out(row: Row) {
  return { phone: row.phone, pro_name: row.pro_name, pro_notify_phone: row.pro_notify_phone }
}

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const { data, error } = await supabaseAdmin.from('customers').select(COLUMNS).eq('id', session.id).maybeSingle()
  if (error || !data) {
    if (error) console.error('[pro/profile] read failed:', error.message)
    return NextResponse.json({ error: 'Profil introuvable / Profile not found' }, { status: 404 })
  }
  return NextResponse.json({ profile: out(data as Row) })
}

export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({}))

  const { data: me, error: readErr } = await supabaseAdmin
    .from('customers').select(COLUMNS).eq('id', session.id).maybeSingle()
  if (readErr || !me) {
    return NextResponse.json({ error: 'Profil introuvable / Profile not found' }, { status: 404 })
  }

  const updates: Record<string, string | null> = {}

  if ('pro_name' in body) {
    const name = sanitizeText(body.pro_name, 80)
    updates.pro_name = name || null
  }

  if ('pro_notify_phone' in body) {
    const raw = typeof body.pro_notify_phone === 'string' ? body.pro_notify_phone.trim() : ''
    if (!raw) {
      updates.pro_notify_phone = null
    } else {
      const country = detectCountry((me as Row).phone) ?? getCountryFromCity((me as Row).city)
      const r = normalizeTypedPhone(raw, country)
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
      if (samePhone(r.phone, (me as Row).phone)) {
        return NextResponse.json({
          error: 'C\'est déjà le numéro de votre compte. / That is already your account number.',
        }, { status: 400 })
      }
      updates.pro_notify_phone = r.phone
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Aucun champ à mettre à jour / Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('customers').update(updates).eq('id', session.id).select(COLUMNS).single()
  if (error || !data) {
    console.error('[pro/profile] update failed:', error?.message)
    return NextResponse.json({ error: 'Erreur — réessayez. / Error — please try again.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, profile: out(data as Row) })
}
