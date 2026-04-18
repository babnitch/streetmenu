import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET — list orphaned restaurants + customers for manual linking
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const [{ data: orphaned }, { data: customers }] = await Promise.all([
    supabaseAdmin
      .from('restaurants')
      .select('id, name, city, neighborhood, whatsapp, status, created_at')
      .is('customer_id', null)
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('customers')
      .select('id, name, phone, city')
      .eq('status', 'active')
      .order('name', { ascending: true }),
  ])

  return NextResponse.json({ orphaned: orphaned ?? [], customers: customers ?? [] })
}

// POST — auto-link all by phone, or manually link one
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json()

  // Manual link: { restaurantId, customerId }
  if (body.restaurantId && body.customerId) {
    const { data: customer } = await supabaseAdmin
      .from('customers').select('id').eq('id', body.customerId).maybeSingle()
    if (!customer) return NextResponse.json({ error: 'Client introuvable / Customer not found' }, { status: 404 })

    const { error } = await supabaseAdmin
      .from('restaurants')
      .update({ customer_id: body.customerId })
      .eq('id', body.restaurantId)
      .is('customer_id', null)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Add owner entry to restaurant_team if not already there
    await supabaseAdmin.from('restaurant_team').upsert({
      restaurant_id: body.restaurantId,
      customer_id:   body.customerId,
      role:          'owner',
      status:        'active',
    }, { onConflict: 'restaurant_id,customer_id' })

    return NextResponse.json({ ok: true, linked: 1 })
  }

  // Auto-link: { autoLink: true }
  // Links orphaned restaurants to existing customers by phone, OR creates a
  // customer from the restaurant's own details when no phone match exists.
  if (body.autoLink) {
    const [{ data: orphaned }, { data: customers }] = await Promise.all([
      supabaseAdmin.from('restaurants').select('id, name, whatsapp, city').is('customer_id', null),
      supabaseAdmin.from('customers').select('id, phone'),
    ])

    const phoneToCustomer: Record<string, string> = {}
    for (const c of customers ?? []) {
      if (c.phone) phoneToCustomer[c.phone] = c.id
    }

    let linked = 0
    let created = 0
    const errors: string[] = []

    for (const r of orphaned ?? []) {
      let customerId = phoneToCustomer[r.whatsapp]

      if (!customerId) {
        const { data: newCustomer, error } = await supabaseAdmin
          .from('customers')
          .insert({ name: r.name, phone: r.whatsapp, city: r.city ?? 'Yaoundé', status: 'active' })
          .select('id').single()

        if (error || !newCustomer) {
          errors.push(`${r.name}: ${error?.message ?? 'unknown'}`)
          continue
        }
        customerId = newCustomer.id
        phoneToCustomer[r.whatsapp] = customerId
        created++
      }

      await supabaseAdmin.from('restaurants')
        .update({ customer_id: customerId })
        .eq('id', r.id)

      await supabaseAdmin.from('restaurant_team').upsert({
        restaurant_id: r.id,
        customer_id:   customerId,
        role:          'owner',
        status:        'active',
        added_by:      'admin',
      }, { onConflict: 'restaurant_id,customer_id' })

      linked++
    }

    return NextResponse.json({ ok: true, linked, created, errors })
  }

  return NextResponse.json({ error: 'Paramètres manquants / Missing parameters' }, { status: 400 })
}
