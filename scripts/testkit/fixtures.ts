// Seed helpers. Every insert goes through track() so teardown and the
// crash-recovery path in ledger.ts know about the row without each suite
// remembering to say so.
//
// Row shapes mirror what the existing scripts already insert (see
// scripts/test-vendor-order-actions.ts and test-ordering-e2e.ts) so a ported
// suite behaves identically. Names and phones come from the reserved
// namespace in env.ts — that is what makes the pattern sweeper possible.
//
// These are used by the DB/API suites landing in steps 2-4 of TEST-PLAN.md
// §6. The unit suites import none of this.

import { sb, testPhone, testName, testCode } from './env'
import { track, installCleanupHandlers } from './ledger'

installCleanupHandlers()

// Per-process sequence so two fixtures in one suite never collide on a phone.
let seq = 0
function nextSeq(): number { return ++seq }

async function insertOne(
  table: string,
  row: Record<string, unknown>,
  select = 'id',
): Promise<Record<string, unknown>> {
  // The generated Supabase types are `any`-shaped for these dynamic table
  // names, so the row goes in untyped and the result comes back through
  // `unknown` rather than fighting the overloads.
  const { data, error } = await sb.from(table).insert(row as never).select(select).single()
  if (error) throw new Error(`fixtures: insert into ${table} failed — ${error.message}`)
  const out = data as unknown as Record<string, unknown>
  track(table, out.id as string)
  return out
}

// ── Customer ────────────────────────────────────────────────────────────────
export interface MakeCustomerOpts {
  suiteNo?: number
  name?:    string
  city?:    string
  status?:  string
  phone?:   string
  /** Extra columns — e.g. { event_auto_approve: false }. */
  extra?:   Record<string, unknown>
}

export interface TestCustomer { id: string; phone: string; name: string; city: string }

// Direct insert, never through the API — creating a customer via the API
// triggers assignWelcomeVoucher and bumps the global BIENVENUE counter
// (TEST-PLAN.md §4 hazard 2).
export async function makeCustomer(opts: MakeCustomerOpts = {}): Promise<TestCustomer> {
  const phone = opts.phone ?? testPhone(opts.suiteNo ?? 0, nextSeq())
  const name  = opts.name ?? `t_customer_${nextSeq()}`
  const city  = opts.city ?? 'Yaoundé'
  // A stale row on this phone would fail the unique index; clear it first.
  await sb.from('customers').delete().eq('phone', phone)
  const row = await insertOne('customers', {
    phone, name, city, status: opts.status ?? 'active', ...(opts.extra ?? {}),
  })
  return { id: row.id as string, phone, name, city }
}

// ── Restaurant ──────────────────────────────────────────────────────────────
export interface MakeRestaurantOpts {
  ownerId?:     string
  label?:       string
  city?:        string
  whatsapp?:    string
  isActive?:    boolean
  status?:      string
  extra?:       Record<string, unknown>
}

export interface TestRestaurant { id: string; name: string; whatsapp: string }

export async function makeRestaurant(opts: MakeRestaurantOpts = {}): Promise<TestRestaurant> {
  const name = testName(opts.label ?? `rest${nextSeq()}`)
  const whatsapp = opts.whatsapp ?? testPhone(0, nextSeq())
  const row = await insertOne('restaurants', {
    name,
    city:         opts.city ?? 'Yaoundé',
    neighborhood: 'Bastos',
    cuisine_type: 'Camerounaise',
    whatsapp,
    customer_id:  opts.ownerId ?? null,
    is_active:    opts.isActive ?? true,
    status:       opts.status ?? 'active',
    lat: 0, lng: 0,
    ...(opts.extra ?? {}),
  })
  // The DB trigger auto-creates the owner's restaurant_team row when
  // customer_id is set. Track it so teardown removes it before the
  // restaurant (TEST-PLAN.md §4 hazard 5).
  if (opts.ownerId) {
    const { data } = await sb.from('restaurant_team')
      .select('id').eq('restaurant_id', row.id as string).eq('customer_id', opts.ownerId).maybeSingle()
    if (data?.id) track('restaurant_team', data.id as string)
  }
  return { id: row.id as string, name, whatsapp }
}

// Adds a team member and tracks the row. upsert on the composite key so the
// trigger-created owner row doesn't abort the call.
export async function addTeamMember(
  restaurantId: string,
  customerId: string,
  role: 'owner' | 'manager' | 'staff',
): Promise<string> {
  const { data, error } = await sb.from('restaurant_team')
    .upsert(
      { restaurant_id: restaurantId, customer_id: customerId, role, status: 'active' },
      { onConflict: 'restaurant_id,customer_id' },
    )
    .select('id').single()
  if (error) throw new Error(`fixtures: addTeamMember failed — ${error.message}`)
  track('restaurant_team', (data as { id: string }).id)
  return (data as { id: string }).id
}

// ── Menu item ───────────────────────────────────────────────────────────────
export interface MakeMenuItemOpts {
  name?:       string
  price?:      number
  category?:   string
  available?:  boolean
  extra?:      Record<string, unknown>
}

export async function makeMenuItem(
  restaurantId: string,
  opts: MakeMenuItemOpts = {},
): Promise<{ id: string; name: string; price: number }> {
  const name  = opts.name ?? testName(`item${nextSeq()}`)
  const price = opts.price ?? 2500
  const row = await insertOne('menu_items', {
    restaurant_id: restaurantId,
    name, price,
    is_available: opts.available ?? true,
    category:     opts.category ?? 'Plats',
    description:  '',
    ...(opts.extra ?? {}),
  })
  return { id: row.id as string, name, price }
}

// ── Event ───────────────────────────────────────────────────────────────────
export interface MakeEventOpts {
  organizerId?: string
  label?:       string
  date?:        string
  city?:        string
  category?:    string
  ticketPrice?: number
  maxTickets?:  number
  isActive?:    boolean
  whatsapp?:    string
  extra?:       Record<string, unknown>
}

export interface TestEvent { id: string; title: string }

// NOTE for the events suite (TEST-PLAN.md §4 hazard 1): approving an event
// fans WhatsApp out to real subscribers matching city + category, and no
// teardown can un-send those. Default city here is deliberately one outside
// SUBSCRIPTION_CITIES; assert countMatchingSubscribers() === 0 before any
// approve call regardless.
export async function makeEvent(opts: MakeEventOpts = {}): Promise<TestEvent> {
  const title = testName(opts.label ?? `event${nextSeq()}`)
  const price = opts.ticketPrice ?? 0
  const row = await insertOne('events', {
    title,
    description:  null,
    date:         opts.date ?? futureDateISO(30),
    time:         null,
    venue:        null,
    city:         opts.city ?? 'Bafoussam',
    neighborhood: null,
    category:     opts.category ?? 'Autre',
    price,
    ticket_price: price,
    max_tickets:  opts.maxTickets ?? 0,
    payment_enabled: false,
    payment_mode: 'reservation_only',
    whatsapp_payment_enabled: false,
    requires_confirmation: false,
    cover_photo:  null,
    whatsapp:     opts.whatsapp ?? testPhone(0, nextSeq()),
    organizer_name: 't_organizer',
    organizer_id: opts.organizerId ?? null,
    is_active:    opts.isActive ?? false,
    auto_approved: false,
    event_status: 'upcoming',
    ...(opts.extra ?? {}),
  })
  return { id: row.id as string, title }
}

export async function makeTier(
  eventId: string,
  opts: { name?: string; price?: number; maxQuantity?: number; extra?: Record<string, unknown> } = {},
): Promise<{ id: string; name: string }> {
  const name = opts.name ?? testName(`tier${nextSeq()}`)
  const row = await insertOne('event_ticket_tiers', {
    event_id:     eventId,
    name,
    price:        opts.price ?? 1000,
    max_quantity: opts.maxQuantity ?? 0,
    sold_count:   0,
    is_active:    true,
    sort_order:   0,
    ...(opts.extra ?? {}),
  })
  return { id: row.id as string, name }
}

// ── Voucher ─────────────────────────────────────────────────────────────────
export interface MakeVoucherOpts {
  label?:        string
  discountType?: 'percent' | 'fixed'
  discountValue?: number
  restaurantId?: string
  minOrder?:     number
  expiresAt?:    string | null
  isActive?:     boolean
  extra?:        Record<string, unknown>
}

export async function makeVoucher(opts: MakeVoucherOpts = {}): Promise<{ id: string; code: string }> {
  const code = testCode(opts.label ?? `v${nextSeq()}`)
  const row = await insertOne('vouchers', {
    code,
    discount_type:  opts.discountType ?? 'percent',
    discount_value: opts.discountValue ?? 10,
    is_active:      opts.isActive ?? true,
    active:         opts.isActive ?? true,
    min_order:      opts.minOrder ?? 0,
    ...(opts.restaurantId ? { restaurant_id: opts.restaurantId } : {}),
    ...(opts.expiresAt !== undefined ? { expires_at: opts.expiresAt } : {}),
    ...(opts.extra ?? {}),
  })
  return { id: row.id as string, code }
}

// ── Order ───────────────────────────────────────────────────────────────────
export async function makeOrder(
  restaurantId: string,
  customer: TestCustomer,
  opts: { status?: string; items?: unknown[]; total?: number; extra?: Record<string, unknown> } = {},
): Promise<{ id: string }> {
  const row = await insertOne('orders', {
    restaurant_id:  restaurantId,
    customer_id:    customer.id,
    customer_name:  customer.name,
    customer_phone: customer.phone,
    items:          opts.items ?? [{ name: 'Ndolé', quantity: 1, price: 2500 }],
    total:          opts.total ?? 2500,
    status:         opts.status ?? 'pending',
    ...(opts.extra ?? {}),
  })
  return { id: row.id as string }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
export function futureDateISO(daysAhead: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  return d.toISOString().slice(0, 10)
}

export function pastDateISO(daysBack: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysBack)
  return d.toISOString().slice(0, 10)
}
