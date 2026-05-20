import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp } from '@/lib/whatsapp'
import { writeAudit } from '@/lib/audit'
import { validatePrepTime, formatPrepTime, PREP_TIME_DEFAULT_MIN, PREP_TIME_DEFAULT_MAX } from '@/lib/prepTime'
import {
  handleOrderCommand,
  handleOrderingSession,
  handleEventSession,
  handleVendorOrderAction,
  handlePaymentRetry,
  type OrderingCustomer,
} from '@/lib/whatsapp/ordering'

export const dynamic = 'force-dynamic'

// ── TwiML ack (replies sent out-of-band via REST) ─────────────────────────────
const EMPTY_TWIML   = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
const TWIML_HEADERS = { 'Content-Type': 'text/xml' }
function ok(): NextResponse {
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS })
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalisePhone(raw: string): string {
  return raw.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '')
}

const CITY_MAP: Record<string, string> = {
  'yaoundé': 'Yaoundé', 'yaounde': 'Yaoundé', '1': 'Yaoundé',
  'abidjan': 'Abidjan',                        '2': 'Abidjan',
  'dakar':   'Dakar',                          '3': 'Dakar',
  'lomé':    'Lomé',    'lome':    'Lomé',     '4': 'Lomé',
}
function parseCity(input: string): string | null {
  return CITY_MAP[input.toLowerCase().trim()] ?? null
}

const CUISINE_MAP: Record<string, string> = {
  'camerounaise':            'Camerounaise', '1': 'Camerounaise',
  'sénégalaise':             'Sénégalaise',
  'senegalaise':             'Sénégalaise',  '2': 'Sénégalaise',
  'ivoirienne':              'Ivoirienne',   '3': 'Ivoirienne',
  'fast-food': 'Fast-food', 'fast food': 'Fast-food', 'fastfood': 'Fast-food', '4': 'Fast-food',
  'grillades':               'Grillades',    '5': 'Grillades',
  'autre':                   'Autre',        '6': 'Autre',
}
function parseCuisine(input: string): string | null {
  return CUISINE_MAP[input.toLowerCase().trim()] ?? null
}

function sessionExpiry(minutes = 60): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

// ── Menu categories ──────────────────────────────────────────────────────────
// Canonical list shown to vendors on WhatsApp + the dashboard <select>. The
// order here is also the numeric-reply order (1. Entrées, 2. Plats…).
const MENU_CATEGORIES = [
  'Entrées',
  'Plats Principaux',
  'Grillades',
  'Boissons',
  'Desserts',
  'Accompagnements',
  'Autre',
] as const
type MenuCategory = typeof MENU_CATEGORIES[number]
const DEFAULT_CATEGORY: MenuCategory = 'Plats Principaux'

// Loose keyword match for the "Name - Price - Category" shortcut and for a
// typed category reply ("plats", "grilled", etc.). Keys are lowercased.
const CATEGORY_KEYWORDS: Record<string, MenuCategory> = {
  'entrée': 'Entrées', 'entrees': 'Entrées', 'entree': 'Entrées', 'entrées': 'Entrées',
  'starter': 'Entrées', 'starters': 'Entrées',
  'plat': 'Plats Principaux', 'plats': 'Plats Principaux',
  'plats principaux': 'Plats Principaux', 'plat principal': 'Plats Principaux',
  'main': 'Plats Principaux', 'main course': 'Plats Principaux', 'main courses': 'Plats Principaux',
  'grillade': 'Grillades', 'grillades': 'Grillades', 'grilled': 'Grillades', 'grill': 'Grillades',
  'boisson': 'Boissons', 'boissons': 'Boissons', 'drink': 'Boissons', 'drinks': 'Boissons',
  'dessert': 'Desserts', 'desserts': 'Desserts',
  'accompagnement': 'Accompagnements', 'accompagnements': 'Accompagnements',
  'side': 'Accompagnements', 'sides': 'Accompagnements',
  'autre': 'Autre', 'other': 'Autre',
}

function matchCategory(input: string): MenuCategory | null {
  const s = input.trim().toLowerCase()
  if (!s) return null
  // Digit reply: "1".."7"
  const n = parseInt(s, 10)
  if (!isNaN(n) && n >= 1 && n <= MENU_CATEGORIES.length) return MENU_CATEGORIES[n - 1]
  // "passer" / "skip" → default
  if (s === 'passer' || s === 'skip') return DEFAULT_CATEGORY
  return CATEGORY_KEYWORDS[s] ?? null
}

// ── Team invitations ─────────────────────────────────────────────────────────
// Lazy expiry — an invitation is treated as dead once `expires_at` is past,
// even if the row still says status='pending'. The cancel/invite flow in
// handleVendor flips the row to 'expired' when it lands on one.

interface PendingInvitation {
  id:             string
  restaurant_id:  string
  role:           'manager' | 'staff'
  expires_at:     string
  restaurants?: { name: string | null } | null
  inviter?: { name: string | null } | null
}

async function loadPendingInvitationsForPhone(phone: string): Promise<PendingInvitation[]> {
  const { data } = await supabaseAdmin
    .from('team_invitations')
    .select('id, restaurant_id, role, expires_at, restaurants(name), inviter:customers!invited_by(name)')
    .eq('phone', phone).eq('status', 'pending')
    .order('created_at', { ascending: false })
  const nowMs = Date.now()
  return ((data ?? []) as unknown as PendingInvitation[])
    .filter(r => new Date(r.expires_at).getTime() > nowMs)
}

// Kick off the WhatsApp registration flow for an invitee who doesn't yet
// have a customer record. Invitation IDs ride along in the session's data
// blob and are consumed once the customer row is created.
async function startInviteAcceptSignup(phone: string, invitationIds: string[]): Promise<void> {
  await supabaseAdmin.from('signup_sessions').upsert({
    phone,
    user_type: 'invite_accept',
    step: 1,
    data: { invitation_ids: invitationIds },
    expires_at: sessionExpiry(),
  })
}

// Called from the top-level router when body is accept/decline. Returns
// NextResponse on success (including the "no pending invitations" reply),
// or null if a caller needs to fall through. For the current wiring we
// always return — the top-level just calls `return ok()` either way.
async function handleInvitationReply(
  from: string,
  phone: string,
  decision: 'accept' | 'decline',
): Promise<NextResponse | null> {
  const pending = await loadPendingInvitationsForPhone(phone)
  if (!pending.length) {
    await sendWhatsApp(from,
      'Aucune invitation en attente pour votre numéro. / No pending invitation for your number.')
    return ok()
  }

  if (decision === 'decline') {
    await supabaseAdmin
      .from('team_invitations')
      .update({ status: 'declined' })
      .in('id', pending.map(p => p.id))

    for (const inv of pending) {
      await writeAudit({
        action: 'team_invitation_declined',
        targetType: 'restaurant_team',
        targetId: inv.id,
        performedBy: null,
        performedByType: 'customer',
        metadata: { restaurant_id: inv.restaurant_id, phone, via: 'whatsapp' },
      })
    }

    // Notify inviting owners so they see the decline.
    for (const inv of pending) {
      const { data: owner } = await supabaseAdmin
        .from('restaurant_team')
        .select('customers(phone)')
        .eq('restaurant_id', inv.restaurant_id).eq('role', 'owner').eq('status', 'active')
        .maybeSingle()
      const ownerPhone = (owner?.customers as unknown as { phone?: string } | null)?.phone
      if (ownerPhone) {
        await sendWhatsApp(ownerPhone,
          `❌ ${phone} a décliné l'invitation (${inv.restaurants?.name ?? 'restaurant'}).\n` +
          `${phone} declined the invitation.`)
      }
    }

    await sendWhatsApp(from, 'OK, invitation déclinée. / Invitation declined.')
    return ok()
  }

  // Accept path. If the invitee isn't a customer yet, start a quick
  // registration session; the handler will complete team-insertion once
  // name + city are provided.
  const { data: customer } = await supabaseAdmin
    .from('customers').select('id, name, phone, status')
    .eq('phone', phone).maybeSingle()

  if (!customer || customer.status !== 'active') {
    await startInviteAcceptSignup(phone, pending.map(p => p.id))
    await sendWhatsApp(from,
      `🎉 Super! Finalisons votre inscription.\nQuel est votre prénom?\n\n` +
      `Let's finish your registration.\nWhat's your first name?`)
    return ok()
  }

  // Already a customer → accept immediately.
  await acceptInvitationsForCustomer(customer.id, customer.phone, customer.name, pending)
  return ok()
}

// Shared between the "already a customer" accept path and the post-signup
// completion: insert team rows + flip invitation statuses + notify owners.
async function acceptInvitationsForCustomer(
  customerId: string,
  customerPhone: string,
  customerName: string,
  pending: PendingInvitation[],
): Promise<void> {
  for (const inv of pending) {
    await supabaseAdmin.from('restaurant_team').upsert({
      restaurant_id: inv.restaurant_id,
      customer_id:   customerId,
      role:          inv.role,
      status:        'active',
    }, { onConflict: 'restaurant_id,customer_id' })

    await supabaseAdmin
      .from('team_invitations')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('id', inv.id)

    await writeAudit({
      action: 'team_invitation_accepted',
      targetType: 'restaurant_team',
      targetId: inv.id,
      performedBy: customerId,
      performedByType: 'customer',
      metadata: {
        restaurant_id: inv.restaurant_id,
        phone: customerPhone,
        role: inv.role,
        via: 'whatsapp',
      },
    })

    // Notify owner of the restaurant that accepted.
    const { data: owner } = await supabaseAdmin
      .from('restaurant_team')
      .select('customers(phone)')
      .eq('restaurant_id', inv.restaurant_id).eq('role', 'owner').eq('status', 'active')
      .maybeSingle()
    const ownerPhone = (owner?.customers as unknown as { phone?: string } | null)?.phone
    if (ownerPhone) {
      await sendWhatsApp(ownerPhone,
        `✅ ${customerPhone} a accepté l'invitation (${inv.restaurants?.name ?? 'restaurant'})!\n` +
        `${customerPhone} accepted the invitation!`)
    }

    // Welcome the invitee.
    await sendWhatsApp(customerPhone,
      `✅ Vous êtes maintenant *${inv.role}* chez *${inv.restaurants?.name ?? 'restaurant'}*, ${customerName}!\n` +
      `Envoyez *aide* pour les commandes.\n\n` +
      `You are now *${inv.role}* at *${inv.restaurants?.name ?? 'restaurant'}*!\n` +
      `Send *help* for commands.`)
  }
}

const CATEGORY_PROMPT =
  '📂 Catégorie? / Category?\n' +
  '1. Entrées / Starters\n' +
  '2. Plats Principaux / Main Courses\n' +
  '3. Grillades / Grilled\n' +
  '4. Boissons / Drinks\n' +
  '5. Desserts\n' +
  '6. Accompagnements / Sides\n' +
  '7. Autre / Other\n\n' +
  'Envoyez le numéro / Send the number\n' +
  '_(ou "passer" pour Plats Principaux / or "skip")_'

const BASE_URL = 'https://streetmenu.vercel.app'

// ── Media helpers ─────────────────────────────────────────────────────────────
async function downloadTwilioMedia(mediaUrl: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const sid    = process.env.TWILIO_API_KEY_SID
  const secret = process.env.TWILIO_API_KEY_SECRET
  if (!sid || !secret) {
    console.error('[whatsapp] downloadTwilioMedia: TWILIO_API_KEY_SID/SECRET missing')
    return null
  }
  console.log('[whatsapp] Downloading from Twilio:', mediaUrl.slice(0, 90))
  try {
    const res = await fetch(mediaUrl, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${secret}`).toString('base64')}`,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[whatsapp] downloadTwilioMedia: HTTP ${res.status} ${res.statusText}`, body.slice(0, 200))
      return null
    }
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const buffer = Buffer.from(await res.arrayBuffer())
    console.log(`[whatsapp] Downloaded ${buffer.length} bytes (${contentType})`)
    return { buffer, contentType }
  } catch (e) {
    console.error('[whatsapp] downloadTwilioMedia threw:', (e as Error).message)
    return null
  }
}

async function uploadToStorage(bucket: string, buffer: Buffer, contentType: string): Promise<string | null> {
  const ext  = contentType.split('/')[1]?.split(';')[0] ?? 'jpg'
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  console.log(`[whatsapp] Uploading to Supabase bucket "${bucket}" at ${path}`)
  const { error } = await supabaseAdmin.storage
    .from(bucket).upload(path, buffer, { contentType, upsert: false })
  if (error) { console.error(`[whatsapp] ${bucket} upload error:`, error.message); return null }
  const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(path)
  console.log(`[whatsapp] Uploaded — public URL: ${data.publicUrl}`)
  return data.publicUrl
}

// ── Menu item lookup (exact then partial, case-insensitive) ───────────────────
async function findMenuItem(restaurantId: string, name: string) {
  const { data: exact } = await supabaseAdmin
    .from('menu_items').select('id, name')
    .eq('restaurant_id', restaurantId).ilike('name', name.trim()).maybeSingle()
  if (exact) return exact

  const { data: partials } = await supabaseAdmin
    .from('menu_items').select('id, name')
    .eq('restaurant_id', restaurantId).ilike('name', `%${name.trim()}%`).limit(1)
  return partials?.[0] ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const params  = Object.fromEntries(new URLSearchParams(rawBody))

  const from      = params['From'] ?? ''
  const body      = (params['Body'] ?? '').trim()
  const numMedia  = parseInt(params['NumMedia'] ?? '0', 10)
  const mediaUrl  = params['MediaUrl0'] ?? ''
  const mediaType = params['MediaContentType0'] ?? ''
  const hasPhoto  = numMedia > 0 && mediaType.startsWith('image/') && !!mediaUrl

  const phone = normalisePhone(from)
  if (!phone) {
    await sendWhatsApp(from, 'Numéro non reconnu. / Unrecognised number.')
    return ok()
  }

  const cmd = body.toLowerCase().trim()

  // Cancel always clears any active session
  if (cmd === 'annuler' || cmd === 'cancel') {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from,
      '❌ Inscription annulée. / Registration cancelled.\n\n' +
      'Envoyez "aide" pour recommencer. / Send "help" to start over.')
    return ok()
  }

  // Check for active session (onboarding or photo-update state).
  // reservations_browse is a transient list cursor that should NOT intercept
  // routing — the cancel-by-number resolver looks it up explicitly inside
  // handleCustomer / handleOrderCommand, and other commands (aide, mes
  // bons, etc.) need to keep working while it's alive.
  const { data: session } = await supabaseAdmin
    .from('signup_sessions').select('*')
    .eq('phone', phone)
    .neq('user_type', 'reservations_browse')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (session) {
    return handleSession(from, phone, body, cmd, session, hasPhoto, mediaUrl)
  }

  // ── INVITATION ACCEPT / DECLINE ──────────────────────────────────────────
  // An invitee may or may not be a registered customer yet. Handle both
  // replies before the customer lookup so a brand-new number can accept and
  // flow straight into the registration/team-insert branch below.
  if (cmd === 'accepter' || cmd === 'accept' || cmd === 'refuser' || cmd === 'refuse' || cmd === 'decline') {
    const decision: 'accept' | 'decline' =
      (cmd === 'accepter' || cmd === 'accept') ? 'accept' : 'decline'
    const handled = await handleInvitationReply(from, phone, decision)
    if (handled) return handled
    // Fall through: no pending invitation exists for this phone — the bot
    // told the user so; no need to dispatch further.
    return ok()
  }

  // Look up registered customer (or check suspension)
  const { data: customer } = await supabaseAdmin
    .from('customers').select('id, name, phone, city, status, deleted_at')
    .eq('phone', phone).maybeSingle()

  if (customer?.deleted_at || customer?.status === 'deleted') {
    await sendWhatsApp(from,
      'Votre compte a été supprimé. / Your account has been deleted.\n' +
      'Contactez le support si vous pensez que c\'est une erreur. / Contact support if you think this is an error.')
    return ok()
  }
  if (customer?.status === 'suspended') {
    await sendWhatsApp(from,
      'Votre compte est suspendu. Contactez le support. / Your account is suspended. Contact support.')
    return ok()
  }

  // Look up all restaurants this phone number belongs to (owner or team member)
  const { data: teamEntries } = await supabaseAdmin
    .from('restaurant_team')
    .select('role, restaurants(id, name, whatsapp, is_active, status, deleted_at, suspended_by, customer_id)')
    .eq('customer_id', customer?.id ?? '')
    .eq('status', 'active')

  type TeamRestaurant = {
    id: string; name: string; whatsapp: string; is_active: boolean; status: string;
    deleted_at: string | null; suspended_by: string | null; customer_id: string | null;
    teamRole: string;
  }
  const activeRestaurants = ((teamEntries ?? [])
    .map(e => ({ ...(e.restaurants as unknown as TeamRestaurant), teamRole: e.role })) as TeamRestaurant[])
    .filter(r => r.is_active && !r.deleted_at && r.status !== 'deleted')

  // Also check direct whatsapp match (for pending vendors without customer account)
  const { data: directRestaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, whatsapp, is_active, customer_id, status, deleted_at, suspended_by')
    .or(`whatsapp.eq.${phone},whatsapp.eq.${from}`)
    .maybeSingle()

  // Handle suspended/deleted restaurants on direct match
  if (directRestaurant?.deleted_at || directRestaurant?.status === 'deleted') {
    await sendWhatsApp(from,
      'Ce restaurant a été supprimé. / This restaurant has been deleted.')
    return ok()
  }
  if (directRestaurant?.status === 'suspended') {
    if (directRestaurant.suspended_by === 'vendor') {
      await sendWhatsApp(from,
        `⏸️ *${directRestaurant.name}* est suspendu par vous-même.\n` +
        `Envoyez "reactiver" pour le réactiver.\n\n` +
        `Send "reactiver" to reactivate.`)
    } else {
      await sendWhatsApp(from,
        `⛔ *${directRestaurant.name}* est suspendu par l'administration.\n` +
        `Contactez le support. / Contact support.`)
    }
    return ok()
  }

  // Handle reactivation command
  if (cmd === 'reactiver' || cmd === 'reactivate') {
    const suspendedOwned = directRestaurant && directRestaurant.status === 'suspended' && directRestaurant.suspended_by === 'vendor'
    if (suspendedOwned) {
      await supabaseAdmin.from('restaurants').update({
        status: 'active', suspended_at: null, suspended_by: null, suspension_reason: null,
      }).eq('id', directRestaurant.id)
      await sendWhatsApp(from, `✅ *${directRestaurant.name}* est maintenant actif! / is now active!`)
      return ok()
    }
  }

  if (directRestaurant?.is_active) {
    // Check if we need to prompt multi-restaurant selection
    if (activeRestaurants.length > 1 && !session) {
      return handleMultiRestaurantSelection(from, phone, cmd, body, hasPhoto, mediaUrl, activeRestaurants)
    }
    const restaurant = { ...directRestaurant, teamRole: 'owner' }
    return handleVendor(from, phone, body, cmd, hasPhoto, mediaUrl, restaurant)
  }
  if (directRestaurant && !directRestaurant.is_active) {
    return handlePendingVendor(from, directRestaurant.name)
  }

  // Check team-based restaurant access
  if (activeRestaurants.length === 1) {
    return handleVendor(from, phone, body, cmd, hasPhoto, mediaUrl, activeRestaurants[0])
  }
  if (activeRestaurants.length > 1) {
    return handleMultiRestaurantSelection(from, phone, cmd, body, hasPhoto, mediaUrl, activeRestaurants)
  }

  if (customer) {
    return handleCustomer(from, phone, cmd, customer)
  }

  // Brand-new user → start customer signup
  await supabaseAdmin.from('signup_sessions').upsert({
    phone, user_type: 'customer', step: 1, data: {}, expires_at: sessionExpiry(),
  })
  await sendWhatsApp(from,
    '👋 Bienvenue sur *Tchop & Ndjoka*!\n' +
    'Inscrivez-vous en 2 étapes. / Welcome! Sign up in 2 steps.\n\n' +
    'Quel est votre *nom*? / What is your *name*?\n\n' +
    '_Envoyez "annuler" pour annuler. / Send "cancel" to cancel._')
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-RESTAURANT SELECTION
// ─────────────────────────────────────────────────────────────────────────────
async function handleMultiRestaurantSelection(
  from: string,
  phone: string,
  cmd: string,
  body: string,
  hasPhoto: boolean,
  mediaUrl: string,
  restaurants: Array<{ id: string; name: string; whatsapp: string; is_active: boolean; customer_id: string | null; teamRole: string; status: string; deleted_at: string | null; suspended_by: string | null }>,
): Promise<NextResponse> {
  // Commands "mes restaurants" or "my restaurants"
  if (cmd === 'mes restaurants' || cmd === 'my restaurants') {
    const lines = restaurants.map((r, i) => `${i + 1}. ${r.name} — ${r.status}`)
    await sendWhatsApp(from,
      `🏪 *Vos restaurants / Your restaurants:*\n\n${lines.join('\n')}\n\n` +
      `Envoyez le numéro pour sélectionner. / Send the number to select.`)
    return ok()
  }

  // Check for an active selection session
  const { data: activeSession } = await supabaseAdmin
    .from('signup_sessions').select('*')
    .eq('phone', phone).eq('user_type', 'restaurant_select')
    .gt('expires_at', new Date().toISOString()).maybeSingle()

  if (activeSession) {
    const num = parseInt(cmd, 10)
    if (!isNaN(num) && num >= 1 && num <= restaurants.length) {
      const chosen = restaurants[num - 1]
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      return handleVendor(from, phone, body, cmd, hasPhoto, mediaUrl, chosen)
    }
    await sendWhatsApp(from, `Envoyez un numéro entre 1 et ${restaurants.length}. / Send a number between 1 and ${restaurants.length}.`)
    return ok()
  }

  // If the command is a number, try to use it directly as selection
  const directNum = parseInt(cmd, 10)
  if (!isNaN(directNum) && directNum >= 1 && directNum <= restaurants.length) {
    return handleVendor(from, phone, body, cmd, hasPhoto, mediaUrl, restaurants[directNum - 1])
  }

  // Ask which restaurant
  const lines = restaurants.map((r, i) => `${i + 1}. ${r.name}`)
  await supabaseAdmin.from('signup_sessions').upsert({
    phone, user_type: 'restaurant_select', step: 1, data: {}, expires_at: sessionExpiry(10),
  })
  await sendWhatsApp(from,
    `Vous avez ${restaurants.length} restaurants. Lequel? / Which restaurant?\n\n` +
    lines.join('\n') + '\n\n' +
    'Envoyez le numéro. / Send the number.')
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION HANDLER  (customer onboarding, vendor onboarding, photo-update state)
// ─────────────────────────────────────────────────────────────────────────────
async function handleSession(
  from:      string,
  phone:     string,
  body:      string,
  cmd:       string,
  session:   { user_type: string; step: number; data: Record<string, string> },
  hasPhoto:  boolean,
  mediaUrl:  string,
): Promise<NextResponse> {
  const { user_type, step, data } = session

  // ── Ordering session — handed off to lib/whatsapp/ordering.ts ────────────
  if (user_type === 'ordering') {
    const { data: customer } = await supabaseAdmin
      .from('customers').select('id, name, phone, city')
      .eq('phone', phone).maybeSingle()
    if (!customer) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, '❌ Session expirée. Envoyez "aide". / Session expired. Send "help".')
      return ok()
    }
    return handleOrderingSession(
      from, phone, body, cmd,
      session as unknown as Parameters<typeof handleOrderingSession>[4],
      customer as OrderingCustomer,
    )
  }

  // ── Event browse / detail / reserve session ──────────────────────────────
  if (user_type === 'event_browse' || user_type === 'event_detail' || user_type === 'event_reserve') {
    const { data: customer } = await supabaseAdmin
      .from('customers').select('id, name, phone, city')
      .eq('phone', phone).maybeSingle()
    if (!customer) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, '❌ Session expirée. Envoyez "aide". / Session expired.')
      return ok()
    }
    return handleEventSession(from, phone, cmd, session as unknown as Parameters<typeof handleEventSession>[3], customer as OrderingCustomer)
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Customer signup (2 steps: name → city)
  // ────────────────────────────────────────────────────────────────────────────
  if (user_type === 'customer') {
    if (step === 1) {
      const name = body.trim()
      if (name.length < 2) {
        await sendWhatsApp(from, 'Merci d\'entrer un prénom valide. / Please enter a valid name.')
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        step: 2, data: { ...data, name }, expires_at: sessionExpiry(),
      }).eq('phone', phone)
      await sendWhatsApp(from,
        `Bonjour *${name}*! 🎉\n\n` +
        'Dans quelle *ville* êtes-vous? / Which *city* are you in?\n\n' +
        '1️⃣ Yaoundé\n2️⃣ Abidjan\n3️⃣ Dakar\n4️⃣ Lomé\n\n' +
        '_Tapez le nom ou le chiffre. / Type name or number._')
      return ok()
    }

    if (step === 2) {
      const city = parseCity(body)
      if (!city) {
        await sendWhatsApp(from, 'Choisissez / Choose:\n1️⃣ Yaoundé  2️⃣ Abidjan  3️⃣ Dakar  4️⃣ Lomé')
        return ok()
      }
      const name = data.name ?? 'Ami'
      const { data: newCustomer, error } = await supabaseAdmin
        .from('customers').insert({ phone, name, city }).select('id').single()
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      if (error || !newCustomer) {
        console.error('[whatsapp] customer insert error:', error?.message)
        await sendWhatsApp(from, '❌ Erreur. Réessayez. / Error. Please retry.')
        return ok()
      }
      const { assignWelcomeVoucher } = await import('@/lib/vouchers')
      await assignWelcomeVoucher(newCustomer.id)
      await sendWhatsApp(from,
        `✅ *Bienvenue ${name}!* 🍽️\n\n` +
        `Votre compte est créé. / Your account is created.\n\n` +
        `🎉 Utilisez le code *BIENVENUE* pour 10% de réduction sur votre première commande!\n` +
        `Use code *BIENVENUE* for 10% off your first order!\n\n` +
        `🌍 Restaurants: ${BASE_URL}\n` +
        `🔑 Mon compte / My account: ${BASE_URL}/account\n\n` +
        `🏪 Vous avez un restaurant? Envoyez *restaurant*!\n` +
        `Own a restaurant? Send *restaurant*!`)
      return ok()
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Invite-accept signup (name → city → customer row + team inserts)
  // Reached when a non-registered number replied "accepter" to a pending
  // team invitation. The invitation IDs ride in `data.invitation_ids`.
  // ────────────────────────────────────────────────────────────────────────────
  if (user_type === 'invite_accept') {
    if (step === 1) {
      const name = body.trim()
      if (name.length < 2) {
        await sendWhatsApp(from, 'Merci d\'entrer un prénom valide. / Please enter a valid name.')
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        step: 2, data: { ...data, name }, expires_at: sessionExpiry(),
      }).eq('phone', phone)
      await sendWhatsApp(from,
        `Bonjour *${name}*! 🎉\n\n` +
        'Dans quelle *ville* êtes-vous? / Which *city* are you in?\n\n' +
        '1️⃣ Yaoundé\n2️⃣ Abidjan\n3️⃣ Dakar\n4️⃣ Lomé\n\n' +
        '_Tapez le nom ou le chiffre. / Type name or number._')
      return ok()
    }

    if (step === 2) {
      const city = parseCity(body)
      if (!city) {
        await sendWhatsApp(from, 'Choisissez / Choose:\n1️⃣ Yaoundé  2️⃣ Abidjan  3️⃣ Dakar  4️⃣ Lomé')
        return ok()
      }
      const name = data.name ?? 'Ami'
      const invitationIds = (data.invitation_ids as unknown as string[] | undefined) ?? []

      const { data: newCustomer, error } = await supabaseAdmin
        .from('customers').insert({ phone, name, city }).select('id, phone, name').single()
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      if (error || !newCustomer) {
        console.error('[whatsapp] invite-accept customer insert error:', error?.message)
        await sendWhatsApp(from, '❌ Erreur. Réessayez. / Error. Please retry.')
        return ok()
      }

      // Reload the (still-pending) invitations by ID — guards against a row
      // being cancelled while the user was typing their name/city.
      const { data: stillPending } = await supabaseAdmin
        .from('team_invitations')
        .select('id, restaurant_id, role, expires_at, restaurants(name)')
        .in('id', invitationIds).eq('status', 'pending')
      const nowMs = Date.now()
      const live = ((stillPending ?? []) as unknown as PendingInvitation[])
        .filter(r => new Date(r.expires_at).getTime() > nowMs)

      if (!live.length) {
        await sendWhatsApp(from,
          `✅ Inscription terminée, *${name}*!\n` +
          `Mais les invitations ne sont plus valables.\n\n` +
          `Registration complete, but the invitations are no longer valid.`)
        return ok()
      }

      await acceptInvitationsForCustomer(newCustomer.id, newCustomer.phone, newCustomer.name, live)
      return ok()
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Vendor signup (5 steps: name → city → neighborhood → cuisine → photo)
  // ────────────────────────────────────────────────────────────────────────────
  if (user_type === 'vendor') {
    // Step 1: restaurant name
    if (step === 1) {
      const restaurantName = body.trim()
      if (restaurantName.length < 2) {
        await sendWhatsApp(from, 'Merci d\'entrer un nom valide. / Please enter a valid name.')
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        step: 2, data: { ...data, restaurant_name: restaurantName }, expires_at: sessionExpiry(),
      }).eq('phone', phone)
      await sendWhatsApp(from,
        `*${restaurantName}* — super! 👍\n\n` +
        'Dans quelle *ville*? / Which *city*?\n\n' +
        '1️⃣ Yaoundé\n2️⃣ Abidjan\n3️⃣ Dakar\n4️⃣ Lomé')
      return ok()
    }

    // Step 2: city
    if (step === 2) {
      const city = parseCity(body)
      if (!city) {
        await sendWhatsApp(from, 'Choisissez / Choose:\n1️⃣ Yaoundé  2️⃣ Abidjan  3️⃣ Dakar  4️⃣ Lomé')
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        step: 3, data: { ...data, city }, expires_at: sessionExpiry(),
      }).eq('phone', phone)
      await sendWhatsApp(from,
        'Dans quel *quartier*? / Which *neighborhood*?\n' +
        '_Ex: Bastos, Plateau, Cocody, Médina…_')
      return ok()
    }

    // Step 3: neighborhood
    if (step === 3) {
      const neighborhood = body.trim()
      if (neighborhood.length < 2) {
        await sendWhatsApp(from, 'Merci d\'entrer un quartier valide. / Please enter a valid neighborhood.')
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        step: 4, data: { ...data, neighborhood }, expires_at: sessionExpiry(),
      }).eq('phone', phone)
      await sendWhatsApp(from,
        'Type de *cuisine*? / *Cuisine* type?\n\n' +
        '1️⃣ Camerounaise\n2️⃣ Sénégalaise\n3️⃣ Ivoirienne\n' +
        '4️⃣ Fast-food\n5️⃣ Grillades\n6️⃣ Autre\n\n' +
        '_Tapez le nom ou le chiffre. / Type name or number._')
      return ok()
    }

    // Step 4: cuisine type
    if (step === 4) {
      const cuisine = parseCuisine(body)
      if (!cuisine) {
        await sendWhatsApp(from,
          'Choisissez / Choose:\n' +
          '1 Camerounaise  2 Sénégalaise  3 Ivoirienne\n4 Fast-food  5 Grillades  6 Autre')
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        step: 5, data: { ...data, cuisine_type: cuisine }, expires_at: sessionExpiry(),
      }).eq('phone', phone)
      await sendWhatsApp(from,
        '📸 Envoyez une *photo de votre restaurant*!\n' +
        'Send a *photo of your restaurant*!\n\n' +
        '_Envoyez "passer" ou "skip" pour ignorer cette étape._\n' +
        '_Send "passer" or "skip" to skip this step._')
      return ok()
    }

    // Step 5: profile photo (or skip)
    if (step === 5) {
      const skip = cmd === 'passer' || cmd === 'skip'
      let imageUrl: string | null = null

      if (!skip) {
        if (!hasPhoto) {
          await sendWhatsApp(from,
            'Envoyez une photo, ou "passer" pour ignorer. / Send a photo, or "passer" to skip.')
          return ok()
        }
        console.log(`[whatsapp] Step 5 photo detected for ${phone}`)
        const media = await downloadTwilioMedia(mediaUrl)
        if (!media) {
          // Don't drop the session — let them retry with another photo or skip.
          await sendWhatsApp(from,
            '⚠️ Impossible de télécharger la photo. Réessayez ou envoyez "passer".\n' +
            'Could not download the photo. Retry or send "skip".')
          return ok()
        }
        imageUrl = await uploadToStorage('restaurant-images', media.buffer, media.contentType)
        if (!imageUrl) {
          await sendWhatsApp(from,
            '⚠️ Impossible d\'enregistrer la photo. Réessayez ou envoyez "passer".\n' +
            'Could not save the photo. Retry or send "skip".')
          return ok()
        }
        console.log(`[whatsapp] Step 5 URL saved to session data: ${imageUrl}`)
      }

      const restaurantName = data.restaurant_name ?? 'Restaurant'
      const neighborhood   = data.neighborhood    ?? ''
      const cuisine        = data.cuisine_type    ?? 'Autre'
      const city           = data.city            ?? ''
      const customerId     = data.customer_id     ?? null

      const { data: newRestaurant, error } = await supabaseAdmin
        .from('restaurants')
        .insert({
          name:         restaurantName,
          neighborhood,
          cuisine_type: cuisine,
          city,
          image_url:    imageUrl,
          whatsapp:     phone,
          customer_id:  customerId,
          is_active:    false,
          lat:          0,
          lng:          0,
        })
        .select('id').single()

      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)

      if (error || !newRestaurant) {
        console.error('[whatsapp] restaurant insert error:', error?.message)
        await sendWhatsApp(from, '❌ Erreur. Réessayez. / Error. Please retry.')
        return ok()
      }

      await sendWhatsApp(from,
        `✅ *${restaurantName}* est enregistré! 🎉\n` +
        `En attente d'approbation (24h). / Pending approval (24h).\n\n` +
        `Votre page / Your page:\n${BASE_URL}/restaurant/${newRestaurant.id}\n\n` +
        `Envoyez *aide* pour les commandes disponibles.\n` +
        `Send *help* for available commands.\n\n` +
        `_Vous pourrez changer la photo plus tard en envoyant "photo restaurant"._\n` +
        `_You can update the photo later by sending "photo restaurant"._`)
      return ok()
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Photo-update state (5-minute window for approved vendors)
  // ────────────────────────────────────────────────────────────────────────────
  if (user_type === 'photo_update') {
    if (!hasPhoto) {
      await sendWhatsApp(from,
        'Envoyez une photo, pas du texte. / Send a photo, not text.\n' +
        '_Ou envoyez "annuler" pour annuler. / Or send "cancel" to cancel._')
      return ok()
    }

    // Find this vendor's restaurant
    const { data: restaurant } = await supabaseAdmin
      .from('restaurants').select('id, name')
      .or(`whatsapp.eq.${phone},whatsapp.eq.whatsapp:${phone}`)
      .maybeSingle()

    const media = await downloadTwilioMedia(mediaUrl)
    const imageUrl = media
      ? await uploadToStorage('restaurant-images', media.buffer, media.contentType)
      : null

    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)

    if (!imageUrl || !restaurant) {
      await sendWhatsApp(from, '❌ Erreur lors de l\'envoi. Réessayez. / Error. Please retry.')
      return ok()
    }

    await supabaseAdmin.from('restaurants').update({ image_url: imageUrl }).eq('id', restaurant.id)
    await sendWhatsApp(from,
      `✅ Photo de *${restaurant.name}* mise à jour! 📸\n` +
      `Restaurant photo updated!\n\n` +
      `Voir ici / See it here:\n${BASE_URL}/restaurant/${restaurant.id}`)
    return ok()
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Menu-item category selection — set while a vendor has a pending dish
  // awaiting its category. Expires in 5 min (see sessionExpiry(5)).
  // ────────────────────────────────────────────────────────────────────────────
  if (user_type === 'menu_category') {
    const category = matchCategory(body)
    if (!category) {
      await sendWhatsApp(from,
        '❓ Choix invalide. / Invalid choice.\n\n' + CATEGORY_PROMPT)
      return ok()
    }

    const restaurantId: string | undefined = data.restaurant_id
    const dishName:     string | undefined = data.name
    const rawPrice:     string | undefined = data.price
    const photoUrl:     string | null      = (data.photo_url as string | null | undefined) ?? null
    const price = rawPrice ? parseInt(rawPrice, 10) : NaN

    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)

    if (!restaurantId || !dishName || isNaN(price) || price <= 0) {
      await sendWhatsApp(from, '❌ Session invalide. Réessayez. / Invalid session. Retry.')
      return ok()
    }

    const { error } = await supabaseAdmin.from('menu_items').insert({
      restaurant_id: restaurantId, name: dishName, price,
      photo_url: photoUrl, category,
      is_available: true, is_daily_special: false, description: '',
    })
    if (error) {
      console.error('[whatsapp] menu insert error:', error.message)
      await sendWhatsApp(from, '❌ Erreur. Réessayez. / Error. Retry.')
      return ok()
    }

    await sendWhatsApp(from,
      `✅ *${dishName}* ajouté${photoUrl ? ' 📸' : ''}\n` +
      `Prix: ${price.toLocaleString()} FCFA\n` +
      `Catégorie: ${category}`)
    return ok()
  }

  // Unknown session state
  await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
  await sendWhatsApp(from, 'Session expirée. Envoyez "aide". / Session expired. Send "help".')
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// APPROVED VENDOR COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
async function handleVendor(
  from:       string,
  phone:      string,
  body:       string,
  cmd:        string,
  hasPhoto:   boolean,
  mediaUrl:   string,
  restaurant: { id: string; name: string; whatsapp: string; is_active: boolean; customer_id: string | null; teamRole?: string; status?: string; deleted_at?: string | null; suspended_by?: string | null },
): Promise<NextResponse> {

  const teamRole = restaurant.teamRole ?? 'owner'
  const isOwner   = teamRole === 'owner'
  const isManager = teamRole === 'manager'
  const canEditMenu   = isOwner || isManager
  const canViewOrders = isOwner || isManager || teamRole === 'staff'

  // ── AIDE / HELP ──────────────────────────────────────────────────────────
  if (cmd === 'aide' || cmd === 'help' || cmd === '') {
    const ownerCmds = isOwner
      ? `\n👥 Équipe / Team:\n` +
        `📋 "equipe" → Voir l'équipe / View team\n` +
        `➕ "ajouter +XXX manager" → Ajouter ou inviter / Add or invite\n` +
        `💌 "inviter +XXX staff" → Inviter un nouveau numéro / Invite a new number\n` +
        `📨 "invitations" → Invitations en attente / Pending invitations\n` +
        `❌ "annuler invitation +XXX" → Annuler / Cancel\n` +
        `➖ "retirer +XXX" → Retirer membre / Remove member\n` +
        `🏪 "mes restaurants" → Voir tous mes restaurants\n` +
        `⏸️ "suspendre" → Suspendre le restaurant\n` +
        `✅ "reactiver" → Réactiver le restaurant\n`
      : ''

    await sendWhatsApp(from,
      `🍽️ *Tchop & Ndjoka — ${restaurant.name}*\n` +
      `Rôle / Role: ${teamRole}\n\n` +
      `📋 *Commandes disponibles / Available commands:*\n\n` +
      (canEditMenu
        ? `📸 Photo + "Nom - Prix" → Ajouter un plat / Add a dish\n` +
          `💰 "prix [nom] [prix]" → Changer le prix / Update price\n` +
          `✅ "dispo [nom]" → Marquer disponible / Mark available\n` +
          `❌ "indispo [nom]" → Marquer indisponible / Mark unavailable\n` +
          `🗑️ "supprimer [nom]" → Supprimer un plat / Delete a dish\n` +
          `📷 "photo restaurant" → Changer la photo / Update restaurant photo\n` +
          `🍽️ "menu" → Voir votre menu / View your menu\n`
        : `🍽️ "menu" → Voir le menu / View menu\n`) +
      (canViewOrders
        ? `📦 *Commandes / Orders:*\n` +
          `📦 "commandes" → Voir les commandes / View orders\n` +
          `✅ "ok XXXX" → Confirmer / Confirm\n` +
          `🍳 "preparer XXXX" → En préparation / Start preparing\n` +
          `🎉 "pret XXXX" → Prêt / Ready\n` +
          `📦 "recupere XXXX" → Récupéré / Picked up\n` +
          `❌ "annuler XXXX" → Annuler / Cancel\n` +
          `💰 "paye XXXX cash" → Marquer payé en espèces / Mark paid cash\n` +
          `💰 "paye XXXX mtn 237..." → Marquer payé MTN / Mark paid MTN\n` +
          `💰 "paye XXXX orange 237..." → Marquer payé Orange / Mark paid Orange\n`
        : '') +
      `🔗 "restaurant" → Voir votre page / View your page\n` +
      `🕐 *Horaires / Hours:*\n` +
      `🕐 "horaire" → Voir l'horaire + statut / View schedule + status\n` +
      ((isOwner || isManager)
        ? `🟢 "ouvrir" → Ouvrir manuellement / Manually open\n` +
          `🔴 "fermer" → Fermer manuellement / Manually close\n` +
          `↩️ "auto" → Suivre l'horaire / Follow schedule\n`
        : '') +
      `⏱️ "temps" → Voir le temps de préparation / View prep time\n` +
      ((isOwner || isManager)
        ? `⏱️ "temps 20 35" → Définir le temps de préparation / Set prep time\n`
        : '') +
      ownerCmds +
      `❓ "aide" → Ce message / This message`)
    return ok()
  }

  // ── RESTAURANT PAGE ──────────────────────────────────────────────────────
  if (cmd === 'restaurant') {
    await sendWhatsApp(from, `🔗 *${restaurant.name}*\n${BASE_URL}/restaurant/${restaurant.id}`)
    return ok()
  }

  // ── SCHEDULE & MANUAL OVERRIDE ───────────────────────────────────────────
  // Mirrors POST /api/restaurants/[id]/override + GET /hours so the vendor
  // can flip "open / closed" without leaving WhatsApp. Owner + manager
  // can flip; staff can only read the current state.
  if (cmd === 'ouvrir' || cmd === 'open' || cmd === 'fermer' || cmd === 'close' || cmd === 'auto') {
    if (!(isOwner || isManager)) {
      await sendWhatsApp(from,
        `Vous n'avez pas la permission de modifier le statut. / You don't have permission.`)
      return ok()
    }
    const next: 'open' | 'closed' | null =
      (cmd === 'ouvrir' || cmd === 'open')  ? 'open' :
      (cmd === 'fermer' || cmd === 'close') ? 'closed' : null
    const { error } = await supabaseAdmin
      .from('restaurants')
      .update({
        manual_override:    next,
        manual_override_at: next === null ? null : new Date().toISOString(),
      })
      .eq('id', restaurant.id)
    if (error) {
      await sendWhatsApp(from, `⚠️ Erreur: ${error.message} / Error.`)
      return ok()
    }
    const { writeAudit } = await import('@/lib/audit')
    await writeAudit({
      action:          next === null ? 'manual_override_removed' : 'manual_override_set',
      targetType:      'restaurant',
      targetId:        restaurant.id,
      performedBy:     null,
      performedByType: 'vendor',
      metadata:        { override: next, via: 'whatsapp' },
    })
    const ack =
      next === 'open'   ? `🟢 *Ouvert manuellement / Manually open*` :
      next === 'closed' ? `🔴 *Fermé manuellement / Manually closed*` :
      `↩️ *Mode automatique / Auto mode*`
    const hint = next === null
      ? `Le restaurant suit à nouveau l'horaire. / Following the schedule again.`
      : `Envoyez "auto" pour revenir à l'horaire. / Send "auto" to follow the schedule.`
    await sendWhatsApp(from, `${ack}\n${restaurant.name}\n\n${hint}`)
    return ok()
  }

  if (cmd === 'horaire' || cmd === 'horaires' || cmd === 'schedule' || cmd === 'hours') {
    // Pull the live schedule + current status from the bulk endpoint so
    // the chat response matches what customers see in the app.
    const [{ data: hours }, { data: rest }] = await Promise.all([
      supabaseAdmin.from('restaurant_hours')
        .select('day_of_week, open_time, close_time, is_closed')
        .eq('restaurant_id', restaurant.id)
        .order('day_of_week', { ascending: true }),
      supabaseAdmin.from('restaurants')
        .select('city, timezone, manual_override')
        .eq('id', restaurant.id).maybeSingle(),
    ])
    const { isRestaurantOpen, formatHoursForDisplay, timezoneForCity } = await import('@/lib/openingHours')
    const tz = rest?.timezone || timezoneForCity(rest?.city)
    const status = isRestaurantOpen({
      manual_override: (rest?.manual_override as 'open' | 'closed' | null) ?? null,
      timezone:        tz,
      hours:           (hours ?? []).map(h => ({
        day_of_week: h.day_of_week,
        open_time:   String(h.open_time).slice(0, 5),
        close_time:  String(h.close_time).slice(0, 5),
        is_closed:   !!h.is_closed,
      })),
    })
    const statusLine = status.source === 'override'
      ? (status.open
          ? `🟢 *Ouvert (manuel) / Open (manual)*`
          : `🔴 *Fermé (manuel) / Closed (manual)*`)
      : (status.open
          ? `🟢 *Ouvert (horaire) / Open (scheduled)*`
          : `🔴 *Fermé (horaire) / Closed (scheduled)*`)
    const nextLine = status.next_transition
      ? (status.next_transition.kind === 'opens'
          ? `· Ouvre à ${status.next_transition.at} / Opens at ${status.next_transition.at}`
          : `· Ferme à ${status.next_transition.at} / Closes at ${status.next_transition.at}`)
      : ''
    const weekLines = formatHoursForDisplay(
      (hours ?? []).map(h => ({
        day_of_week: h.day_of_week,
        open_time:   String(h.open_time).slice(0, 5),
        close_time:  String(h.close_time).slice(0, 5),
        is_closed:   !!h.is_closed,
      })),
      'fr',
    )
    await sendWhatsApp(from,
      `${statusLine} ${nextLine}\n${restaurant.name}\n\n` +
      `🕐 Horaires / Hours:\n${weekLines.join('\n')}\n\n` +
      `Commandes / Commands:\n` +
      `🟢 "ouvrir" / "open" → Ouvrir manuellement\n` +
      `🔴 "fermer" / "close" → Fermer manuellement\n` +
      `↩️ "auto" → Suivre l'horaire / Follow schedule`)
    return ok()
  }

  // ── PREP TIME ────────────────────────────────────────────────────────────
  // "temps" / "preptime" → show the current range.
  // "temps 20 35" / "preptime 20 35" → set min 20, max 35.
  // Anyone on the team can read it; owner + manager can set it (same as
  // the manual open/close override). Mirrors PATCH /api/restaurants/[id].
  {
    const prepView = /^(?:temps|preptime|prep)$/.test(cmd)
    const prepSet  = cmd.match(/^(?:temps|preptime|prep)\s+(\d{1,3})\s+(\d{1,3})$/)
    if (prepView || prepSet) {
      if (prepView) {
        const { data: r } = await supabaseAdmin
          .from('restaurants').select('prep_time_min, prep_time_max')
          .eq('id', restaurant.id).maybeSingle()
        const label = formatPrepTime(r?.prep_time_min, r?.prep_time_max)
        await sendWhatsApp(from,
          `🕐 *Temps de préparation / Prep time — ${restaurant.name}*\n\n` +
          (label
            ? `Actuel / Current: *${label}*\n\n`
            : `Aucun temps défini. / No prep time set.\n\n`) +
          (isOwner || isManager
            ? `Pour changer / To change:\n` +
              `"temps 20 35" → min 20 min, max 35 min\n\n` +
              `💡 La plupart des restaurants mettent ${PREP_TIME_DEFAULT_MIN}-${PREP_TIME_DEFAULT_MAX} min / ` +
              `Most restaurants set ${PREP_TIME_DEFAULT_MIN}-${PREP_TIME_DEFAULT_MAX} min`
            : `Seuls le propriétaire et le manager peuvent le modifier. / Only the owner and manager can change it.`))
        return ok()
      }
      // Set path
      if (!(isOwner || isManager)) {
        await sendWhatsApp(from,
          `Vous n'avez pas la permission de modifier le temps de préparation. / You don't have permission.`)
        return ok()
      }
      const v = validatePrepTime(Number(prepSet![1]), Number(prepSet![2]))
      if (!v.ok) {
        await sendWhatsApp(from,
          `❌ ${v.error}\n\n` +
          `Format: "temps 20 35" (min ≥ 5, max ≤ 120, min < max)`)
        return ok()
      }
      const { data: before } = await supabaseAdmin
        .from('restaurants').select('prep_time_min, prep_time_max')
        .eq('id', restaurant.id).maybeSingle()
      const { error } = await supabaseAdmin
        .from('restaurants')
        .update({ prep_time_min: v.min, prep_time_max: v.max })
        .eq('id', restaurant.id)
      if (error) {
        await sendWhatsApp(from, `⚠️ Erreur: ${error.message} / Error.`)
        return ok()
      }
      await writeAudit({
        action:          'prep_time_updated',
        targetType:      'restaurant',
        targetId:        restaurant.id,
        performedBy:     null,
        performedByType: 'vendor',
        previousData:    { prep_time_min: before?.prep_time_min, prep_time_max: before?.prep_time_max },
        metadata:        { prep_time_min: v.min, prep_time_max: v.max, via: 'whatsapp' },
      })
      await sendWhatsApp(from,
        `✅ *Temps de préparation mis à jour / Prep time updated*\n` +
        `${restaurant.name}\n\n` +
        `🕐 ${v.min}-${v.max} min\n\n` +
        `Affiché aux clients. / Shown to customers.`)
      return ok()
    }
  }

  // ── TEAM MANAGEMENT (owner only) ─────────────────────────────────────────
  if (cmd === 'equipe' || cmd === 'team') {
    if (!isOwner) {
      await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission. Contactez le propriétaire / Contact the owner.')
      return ok()
    }
    const { data: members } = await supabaseAdmin
      .from('restaurant_team')
      .select('role, customers(name, phone)')
      .eq('restaurant_id', restaurant.id)
      .eq('status', 'active')

    if (!members || members.length === 0) {
      await sendWhatsApp(from, `👥 *Équipe — ${restaurant.name}*\n\nAucun membre. Ajoutez avec:\n"ajouter +XXX manager"\n\nNo members. Add with:\n"ajouter +XXX manager"`)
      return ok()
    }
    const lines = members.map(m => {
      const c = m.customers as unknown as { name: string; phone: string }
      return `• ${c.name} (${c.phone}) — ${m.role}`
    })
    await sendWhatsApp(from, `👥 *Équipe — ${restaurant.name}*\n\n${lines.join('\n')}`)
    return ok()
  }

  // ── ADD / INVITE TEAM MEMBER: "ajouter +237XXX manager" or "inviter ..."
  // If the number is already a customer → insert into restaurant_team
  // immediately (existing behaviour). If not → create a pending row in
  // team_invitations + fire a WhatsApp invite. Invitee replies accept/decline.
  //
  // The phone can be entered as a bare local number ("670000000") — the
  // country code is auto-prepended from the restaurant's city. Vendors no
  // longer have to type the +237.
  const addMemberMatch = body.match(/^(?:ajouter|add|inviter|invite)\s+(\+?[\d\s-]+)\s+(manager|staff)$/i)
  if (addMemberMatch) {
    if (!isOwner) {
      await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission.')
      return ok()
    }
    const rawMemberPhone = addMemberMatch[1].trim()
    const memberRole  = addMemberMatch[2].toLowerCase() as 'manager' | 'staff'

    // Look up the restaurant's city so we can fall back to the right
    // dial code when the vendor typed a bare local number.
    const { data: restRow } = await supabaseAdmin
      .from('restaurants').select('city').eq('id', restaurant.id).maybeSingle()
    const { ensureInternational, getCountryFromCity } = await import('@/lib/phoneValidation')
    const fallbackCountry = getCountryFromCity(restRow?.city ?? '')
    const memberPhone = ensureInternational(rawMemberPhone, fallbackCountry)
    if (!memberPhone || !/^\+\d{8,}$/.test(memberPhone)) {
      await sendWhatsApp(from, '❌ Numéro invalide. / Invalid phone number.')
      return ok()
    }

    const { data: ownerCustomer } = await supabaseAdmin
      .from('customers').select('id, name').eq('phone', phone).maybeSingle()

    const { data: newMember } = await supabaseAdmin
      .from('customers').select('id, name, phone, status')
      .eq('phone', memberPhone).maybeSingle()

    if (newMember && newMember.status === 'active') {
      await supabaseAdmin.from('restaurant_team').upsert({
        restaurant_id: restaurant.id, customer_id: newMember.id, role: memberRole,
        added_by: ownerCustomer?.id ?? null, status: 'active',
      }, { onConflict: 'restaurant_id,customer_id' })

      await sendWhatsApp(newMember.phone,
        `✅ *${ownerCustomer?.name ?? 'Le propriétaire'}* vous a ajouté comme *${memberRole}* chez *${restaurant.name}*!\n` +
        `Connectez-vous pour voir votre restaurant.\n\n` +
        `*${ownerCustomer?.name ?? 'The owner'}* added you as *${memberRole}* at *${restaurant.name}*.\n` +
        `Log in to see your restaurant.`)

      await sendWhatsApp(from, `✅ ${newMember.name} ajouté comme *${memberRole}*. / Added as *${memberRole}*.`)
      return ok()
    }

    // Invitation path — the phone isn't a known customer. Clear any stale
    // pending row so the partial unique index doesn't collide, then insert
    // a fresh invitation and send the invite message.
    const { data: stale } = await supabaseAdmin
      .from('team_invitations').select('id, expires_at')
      .eq('restaurant_id', restaurant.id).eq('phone', memberPhone).eq('status', 'pending')
      .maybeSingle()

    if (stale && new Date(stale.expires_at) > new Date()) {
      await sendWhatsApp(from,
        `⏳ Une invitation est déjà en attente pour ${memberPhone}. / A pending invitation already exists.`)
      return ok()
    }
    if (stale) {
      await supabaseAdmin.from('team_invitations').update({ status: 'expired' }).eq('id', stale.id)
      await writeAudit({
        action: 'team_invitation_expired',
        targetType: 'restaurant_team',
        targetId: stale.id,
        performedBy: ownerCustomer?.id ?? null,
        performedByType: 'system',
        metadata: { restaurant_id: restaurant.id, phone: memberPhone, via: 'whatsapp-replace' },
      })
    }

    const { data: invitation, error: invErr } = await supabaseAdmin
      .from('team_invitations').insert({
        restaurant_id: restaurant.id, phone: memberPhone, role: memberRole,
        invited_by: ownerCustomer?.id ?? null, status: 'pending',
      })
      .select('id').single()

    if (invErr || !invitation) {
      console.error('[whatsapp] invitation insert error:', invErr?.message)
      await sendWhatsApp(from, '❌ Erreur. Réessayez. / Error. Retry.')
      return ok()
    }

    await writeAudit({
      action: 'team_invitation_sent',
      targetType: 'restaurant_team',
      targetId: invitation.id,
      performedBy: ownerCustomer?.id ?? null,
      performedByType: 'vendor',
      metadata: {
        restaurant_id: restaurant.id,
        restaurant_name: restaurant.name,
        role: memberRole,
        invited_phone: memberPhone,
        via: 'whatsapp',
      },
    })

    await sendWhatsApp(memberPhone,
      `👋 *${ownerCustomer?.name ?? 'Quelqu\'un'}* vous invite comme *${memberRole}* chez *${restaurant.name}* sur Tchop & Ndjoka!\n\n` +
      `Envoyez *accepter* pour rejoindre. Vous serez inscrit automatiquement.\n` +
      `Envoyez *refuser* pour décliner.\n\n` +
      `*${ownerCustomer?.name ?? 'Someone'}* invites you as *${memberRole}* at *${restaurant.name}* on Tchop & Ndjoka!\n` +
      `Send *accept* to join — you'll be registered automatically.\n` +
      `Send *decline* to decline.`)

    await sendWhatsApp(from,
      `📨 Invitation envoyée à ${memberPhone}. En attente d'acceptation.\n` +
      `Invitation sent. Waiting for acceptance.`)
    return ok()
  }

  // ── INVITATIONS: list pending ────────────────────────────────────────────
  if (cmd === 'invitations' || cmd === 'invitation') {
    if (!isOwner) {
      await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission.')
      return ok()
    }
    const { data: pending } = await supabaseAdmin
      .from('team_invitations')
      .select('phone, role, created_at, expires_at')
      .eq('restaurant_id', restaurant.id).eq('status', 'pending')
      .order('created_at', { ascending: false })

    const nowMs = Date.now()
    const live = (pending ?? []).filter(p => new Date(p.expires_at).getTime() > nowMs)
    if (!live.length) {
      await sendWhatsApp(from,
        `📨 Aucune invitation en attente. / No pending invitations.\n\n` +
        `Invitez avec: / Invite with:\n"inviter +237XXX manager"`)
      return ok()
    }
    const lines = live.map((p, i) => {
      const daysAgo = Math.max(0, Math.floor((nowMs - new Date(p.created_at).getTime()) / 86_400_000))
      return `${i + 1}. ${p.phone} — ${p.role} — ${daysAgo}j / ${daysAgo}d`
    })
    await sendWhatsApp(from,
      `📨 *Invitations en attente / Pending invitations*\n${lines.join('\n')}\n\n` +
      `Annuler: / Cancel: "annuler invitation +237XXX"`)
    return ok()
  }

  // ── CANCEL INVITATION: "annuler invitation +237XXX" ──────────────────────
  const cancelInvMatch = body.match(/^(?:annuler\s+invitation|cancel\s+invitation)\s+(\+?[\d\s-]+)$/i)
  if (cancelInvMatch) {
    if (!isOwner) {
      await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission.')
      return ok()
    }
    const rawTarget = cancelInvMatch[1].trim()
    const { data: restRow2 } = await supabaseAdmin
      .from('restaurants').select('city').eq('id', restaurant.id).maybeSingle()
    const { ensureInternational, getCountryFromCity } = await import('@/lib/phoneValidation')
    const targetPhone = ensureInternational(rawTarget, getCountryFromCity(restRow2?.city ?? ''))
    const { data: inv } = await supabaseAdmin
      .from('team_invitations').select('id')
      .eq('restaurant_id', restaurant.id).eq('phone', targetPhone).eq('status', 'pending')
      .maybeSingle()
    if (!inv) {
      await sendWhatsApp(from, '❌ Aucune invitation en attente pour ce numéro. / No pending invitation for this number.')
      return ok()
    }
    await supabaseAdmin.from('team_invitations').update({ status: 'cancelled' }).eq('id', inv.id)

    const { data: ownerRow } = await supabaseAdmin
      .from('customers').select('id').eq('phone', phone).maybeSingle()

    await writeAudit({
      action: 'team_invitation_cancelled',
      targetType: 'restaurant_team',
      targetId: inv.id,
      performedBy: ownerRow?.id ?? null,
      performedByType: 'vendor',
      metadata: { restaurant_id: restaurant.id, phone: targetPhone, via: 'whatsapp' },
    })

    await sendWhatsApp(from, 'Invitation annulée. / Invitation cancelled.')
    return ok()
  }

  // ── REMOVE TEAM MEMBER: "retirer +237XXX" ────────────────────────────────
  const removeMemberMatch = body.match(/^(?:retirer|remove)\s+(\+?[\d\s-]+)$/i)
  if (removeMemberMatch) {
    if (!isOwner) {
      await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission.')
      return ok()
    }
    const rawRemove = removeMemberMatch[1].trim()
    const { data: restRow3 } = await supabaseAdmin
      .from('restaurants').select('city').eq('id', restaurant.id).maybeSingle()
    const { ensureInternational, getCountryFromCity } = await import('@/lib/phoneValidation')
    const memberPhone = ensureInternational(rawRemove, getCountryFromCity(restRow3?.city ?? ''))
    const { data: memberCustomer } = await supabaseAdmin
      .from('customers').select('id, name, phone').eq('phone', memberPhone).maybeSingle()

    if (!memberCustomer) {
      await sendWhatsApp(from, `❌ Numéro introuvable. / Number not found.`)
      return ok()
    }

    await supabaseAdmin.from('restaurant_team')
      .update({ status: 'removed' })
      .eq('restaurant_id', restaurant.id).eq('customer_id', memberCustomer.id)

    await sendWhatsApp(memberCustomer.phone,
      `👋 Vous avez été retiré de *${restaurant.name}*.\nYou have been removed from *${restaurant.name}*.`)
    await sendWhatsApp(from, `✅ ${memberCustomer.name} retiré de l'équipe. / Removed from team.`)
    return ok()
  }

  // ── SUSPEND (owner only) ──────────────────────────────────────────────────
  if (cmd === 'suspendre' || cmd === 'suspend') {
    if (!isOwner) {
      await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission.')
      return ok()
    }
    await supabaseAdmin.from('restaurants').update({
      status: 'suspended', suspended_at: new Date().toISOString(), suspended_by: 'vendor',
    }).eq('id', restaurant.id)
    await sendWhatsApp(from,
      `⏸️ *${restaurant.name}* suspendu. Envoyez "reactiver" pour réactiver.\n` +
      `Suspended. Send "reactiver" to reactivate.`)
    return ok()
  }

  // ── START PHOTO-UPDATE STATE ─────────────────────────────────────────────
  if (cmd === 'photo restaurant' || cmd === 'photo profil' || cmd === 'profile photo' || cmd === 'photo') {
    await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'photo_update', step: 1, data: {},
      expires_at: sessionExpiry(5), // 5-minute window
    })
    await sendWhatsApp(from,
      '📷 Envoyez la photo de votre restaurant maintenant.\n' +
      'Send your restaurant photo now.\n\n' +
      '_Expire dans 5 minutes. / Expires in 5 minutes._')
    return ok()
  }

  // ── VIEW MENU ────────────────────────────────────────────────────────────
  if (cmd === 'menu') {
    const { data: items } = await supabaseAdmin
      .from('menu_items').select('name, price, is_available')
      .eq('restaurant_id', restaurant.id).order('name')
    if (!items || items.length === 0) {
      await sendWhatsApp(from,
        'Votre menu est vide. / Your menu is empty.\n\n' +
        'Ajoutez un plat: "Ndolé - 2500"\nAdd a dish: "Ndolé - 2500"')
      return ok()
    }
    const lines = items.map(i =>
      `${i.is_available ? '✅' : '❌'} ${i.name} — ${Number(i.price).toLocaleString()} FCFA`)
    await sendWhatsApp(from,
      `🍽️ *Menu — ${restaurant.name}*\n(${items.length} plat${items.length > 1 ? 's' : ''})\n\n` +
      lines.join('\n'))
    return ok()
  }

  // ── PENDING ORDERS ───────────────────────────────────────────────────────
  if ((cmd === 'commandes' || cmd === 'orders') && !canViewOrders) {
    await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission. Contactez le propriétaire / Contact the owner.')
    return ok()
  }
  if (cmd === 'commandes' || cmd === 'orders') {
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, customer_name, customer_phone, items, total_price, status, created_at')
      .eq('restaurant_id', restaurant.id)
      .in('status', ['pending', 'confirmed', 'preparing'])
      .order('created_at', { ascending: false }).limit(10)
    if (!orders || orders.length === 0) {
      await sendWhatsApp(from, 'Aucune commande en attente. ✅\nNo pending orders. ✅')
      return ok()
    }
    const lines = orders.map(o => {
      const time = new Date(o.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      const items = Array.isArray(o.items)
        ? o.items.map((i: { name: string; quantity: number }) => `${i.quantity}× ${i.name}`).join(', ')
        : ''
      return `[${time}] ${o.customer_name} — ${Number(o.total_price).toLocaleString()} FCFA\n  ${items}`
    })
    await sendWhatsApp(from,
      `🛒 *Commandes en cours — ${restaurant.name}*\n` +
      `(${orders.length} commande${orders.length > 1 ? 's' : ''})\n\n` +
      lines.join('\n\n'))
    return ok()
  }

  // ── UPDATE PRICE: "prix Ndolé 3000" or "price Ndolé 3000" ───────────────
  const priceMatch = body.match(/^(?:prix|price)\s+(.+?)\s+(\d[\d\s]*)$/i)
  if (priceMatch && !canEditMenu) {
    await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission. Contactez le propriétaire / Contact the owner.')
    return ok()
  }
  if (priceMatch) {
    const itemName = priceMatch[1].trim()
    const newPrice = parseInt(priceMatch[2].replace(/\s/g, ''), 10)
    if (isNaN(newPrice) || newPrice <= 0) {
      await sendWhatsApp(from, 'Prix invalide. Ex: prix Ndolé 3000 / Invalid price.')
      return ok()
    }
    const item = await findMenuItem(restaurant.id, itemName)
    if (!item) {
      await sendWhatsApp(from, `❌ "${itemName}" introuvable dans votre menu. / Not found in your menu.`)
      return ok()
    }
    await supabaseAdmin.from('menu_items').update({ price: newPrice }).eq('id', item.id)
    await sendWhatsApp(from,
      `✅ *${item.name}* → ${newPrice.toLocaleString()} FCFA`)
    return ok()
  }

  // ── MARK AVAILABLE: "dispo Ndolé" or "available Ndolé" ──────────────────
  const dispoMatch = body.match(/^(?:dispo|available)\s+(.+)$/i)
  if (dispoMatch && !canEditMenu) {
    await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission.')
    return ok()
  }
  if (dispoMatch) {
    const itemName = dispoMatch[1].trim()
    const item = await findMenuItem(restaurant.id, itemName)
    if (!item) {
      await sendWhatsApp(from, `❌ "${itemName}" introuvable. / Not found.`)
      return ok()
    }
    await supabaseAdmin.from('menu_items').update({ is_available: true }).eq('id', item.id)
    await sendWhatsApp(from, `✅ *${item.name}* marqué disponible / marked available`)
    return ok()
  }

  // ── MARK UNAVAILABLE: "indispo Ndolé" or "unavailable Ndolé" ────────────
  const indispoMatch = body.match(/^(?:indispo|unavailable)\s+(.+)$/i)
  if (indispoMatch && !canEditMenu) {
    await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission.')
    return ok()
  }
  if (indispoMatch) {
    const itemName = indispoMatch[1].trim()
    const item = await findMenuItem(restaurant.id, itemName)
    if (!item) {
      await sendWhatsApp(from, `❌ "${itemName}" introuvable. / Not found.`)
      return ok()
    }
    await supabaseAdmin.from('menu_items').update({ is_available: false }).eq('id', item.id)
    await sendWhatsApp(from, `❌ *${item.name}* marqué indisponible / marked unavailable`)
    return ok()
  }

  // ── DELETE ITEM: "supprimer Ndolé" or "delete Ndolé" ────────────────────
  const deleteMatch = body.match(/^(?:supprimer|delete)\s+(.+)$/i)
  if (deleteMatch && !canEditMenu) {
    await sendWhatsApp(from, 'Vous n\'avez pas la permission. / You don\'t have permission.')
    return ok()
  }
  if (deleteMatch) {
    const itemName = deleteMatch[1].trim()
    const item = await findMenuItem(restaurant.id, itemName)
    if (!item) {
      await sendWhatsApp(from, `❌ "${itemName}" introuvable. / Not found.`)
      return ok()
    }
    await supabaseAdmin.from('menu_items').delete().eq('id', item.id)
    await sendWhatsApp(from, `🗑️ *${item.name}* supprimé du menu / removed from menu`)
    return ok()
  }

  // ── PHOTO WITH CAPTION ───────────────────────────────────────────────────
  if (hasPhoto && !canEditMenu) {
    await sendWhatsApp(from, 'Vous n\'avez pas la permission de modifier le menu. / You don\'t have permission to edit the menu.')
    return ok()
  }
  if (hasPhoto) {
    const caption = body.trim()

    // 3-part shortcut "Name - Price - Category" → insert immediately.
    // 2-part "Name - Price" → upload photo, stash pending item in session,
    // then prompt vendor to pick a category.
    const threePart = caption.match(/^(.+?)\s*[-\u2013\u2014]\s*([\d\s]+)\s*[-\u2013\u2014]\s*(.+?)\s*$/)
    const twoPart   = threePart ? null
      : caption.match(/^(.+?)\s*[-\u2013\u2014]\s*([\d\s]+)\s*$/)

    if (threePart || twoPart) {
      const match    = (threePart ?? twoPart) as RegExpMatchArray
      const dishName = match[1].trim()
      const price    = parseInt(match[2].replace(/\s/g, ''), 10)
      if (!dishName || isNaN(price) || price <= 0) {
        await sendWhatsApp(from, 'Format invalide. Ex: Ndolé - 2500')
        return ok()
      }
      const media    = await downloadTwilioMedia(mediaUrl)
      const photoUrl = media ? await uploadToStorage('menu-images', media.buffer, media.contentType) : null

      const category = threePart ? matchCategory(match[3]) : null
      if (threePart && !category) {
        await sendWhatsApp(from,
          `❓ Catégorie "${match[3].trim()}" non reconnue. / Unknown category.\n\n` +
          CATEGORY_PROMPT)
        await supabaseAdmin.from('signup_sessions').upsert({
          phone, user_type: 'menu_category', step: 1,
          data: { restaurant_id: restaurant.id, name: dishName, price: String(price), photo_url: photoUrl },
          expires_at: sessionExpiry(5),
        })
        return ok()
      }

      if (category) {
        const { error } = await supabaseAdmin.from('menu_items').insert({
          restaurant_id: restaurant.id, name: dishName, price,
          photo_url: photoUrl, category,
          is_available: true, is_daily_special: false, description: '',
        })
        if (error) {
          console.error('[whatsapp] menu insert error:', error.message)
          await sendWhatsApp(from, '❌ Erreur. Réessayez. / Error. Retry.')
          return ok()
        }
        await sendWhatsApp(from,
          `✅ *${dishName}* ajouté${photoUrl ? ' 📸' : ''}\n` +
          `Prix: ${price.toLocaleString()} FCFA\n` +
          `Catégorie: ${category}`)
        return ok()
      }

      // 2-part flow: photo uploaded, dish pending, ask for category.
      await supabaseAdmin.from('signup_sessions').upsert({
        phone, user_type: 'menu_category', step: 1,
        data: { restaurant_id: restaurant.id, name: dishName, price: String(price), photo_url: photoUrl },
        expires_at: sessionExpiry(5),
      })
      await sendWhatsApp(from,
        `✅ *${dishName}* (${price.toLocaleString()} FCFA)${photoUrl ? ' 📸' : ''}\n\n` +
        CATEGORY_PROMPT)
      return ok()
    }

    // Caption matches an existing item name → update its photo
    if (caption.length > 0) {
      const item = await findMenuItem(restaurant.id, caption)
      if (item) {
        const media    = await downloadTwilioMedia(mediaUrl)
        const photoUrl = media ? await uploadToStorage('menu-images', media.buffer, media.contentType) : null
        if (photoUrl) {
          await supabaseAdmin.from('menu_items').update({ photo_url: photoUrl }).eq('id', item.id)
          await sendWhatsApp(from, `📸 Photo de *${item.name}* mise à jour! / updated!`)
        } else {
          await sendWhatsApp(from, '❌ Erreur upload photo. Réessayez. / Photo upload error. Retry.')
        }
        return ok()
      }
    }

    // No usable caption
    await sendWhatsApp(from,
      'Ajoutez le nom et le prix dans la légende.\n' +
      'Ex: *Ndolé - 2500*\n\n' +
      'Add the name and price in the caption.\n' +
      'Ex: *Ndolé - 2500*')
    return ok()
  }

  // ── ADD ITEM (text only, no photo) ───────────────────────────────────────
  // 3-part "Ndolé - 2500 - Plats" → insert directly.
  // 2-part "Ndolé - 2500"         → prompt for category.
  const textThreePart = body.match(/^(.+?)\s*[-–—]\s*([\d\s]+)\s*[-–—]\s*(.+?)\s*$/)
  const textTwoPart   = textThreePart ? null
    : body.match(/^(.+?)\s*[-–—]\s*([\d\s]+)\s*$/)
  if ((textThreePart || textTwoPart) && !canEditMenu) {
    await sendWhatsApp(from, 'Vous n\'avez pas la permission de modifier le menu. / You don\'t have permission.')
    return ok()
  }
  if (textThreePart || textTwoPart) {
    const match    = (textThreePart ?? textTwoPart) as RegExpMatchArray
    const dishName = match[1].trim()
    const price    = parseInt(match[2].replace(/\s/g, ''), 10)
    if (!dishName || isNaN(price) || price <= 0) {
      await sendWhatsApp(from, 'Format invalide. Ex: Ndolé - 2500')
      return ok()
    }
    const category = textThreePart ? matchCategory(match[3]) : null

    if (textThreePart && !category) {
      await sendWhatsApp(from,
        `❓ Catégorie "${match[3].trim()}" non reconnue. / Unknown category.\n\n` +
        CATEGORY_PROMPT)
      await supabaseAdmin.from('signup_sessions').upsert({
        phone, user_type: 'menu_category', step: 1,
        data: { restaurant_id: restaurant.id, name: dishName, price: String(price), photo_url: null },
        expires_at: sessionExpiry(5),
      })
      return ok()
    }

    if (category) {
      const { error } = await supabaseAdmin.from('menu_items').insert({
        restaurant_id: restaurant.id, name: dishName, price,
        photo_url: null, category,
        is_available: true, is_daily_special: false, description: '',
      })
      if (error) {
        console.error('[whatsapp] menu insert error:', error.message)
        await sendWhatsApp(from, '❌ Erreur. Réessayez. / Error. Retry.')
        return ok()
      }
      await sendWhatsApp(from,
        `✅ *${dishName}* ajouté au menu\n` +
        `Prix: ${price.toLocaleString()} FCFA\n` +
        `Catégorie: ${category}\n\n` +
        '📸 Envoyez une photo avec la même légende pour ajouter une image.\n' +
        '📸 Send a photo with the same caption to add an image.')
      return ok()
    }

    // 2-part flow: stash pending item + prompt for category.
    await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'menu_category', step: 1,
      data: { restaurant_id: restaurant.id, name: dishName, price: String(price), photo_url: null },
      expires_at: sessionExpiry(5),
    })
    await sendWhatsApp(from,
      `✅ *${dishName}* (${price.toLocaleString()} FCFA)\n\n` + CATEGORY_PROMPT)
    return ok()
  }

  // ── VENDOR ORDER ACTIONS: ok XXXX / pret XXXX / annuler XXXX ─────────────
  if (canViewOrders) {
    const actionResp = await handleVendorOrderAction(from, body, { id: restaurant.id, name: restaurant.name })
    if (actionResp) return actionResp
  }

  // ── Unknown ──────────────────────────────────────────────────────────────
  await sendWhatsApp(from,
    'Je n\'ai pas compris. Envoyez *aide* pour la liste des commandes.\n' +
    'I didn\'t understand. Send *help* for the list of commands.')
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING VENDOR
// ─────────────────────────────────────────────────────────────────────────────
async function handlePendingVendor(from: string, restaurantName: string): Promise<NextResponse> {
  await sendWhatsApp(from,
    `⏳ *${restaurantName}* est en attente de validation.\n` +
    'Your restaurant is pending approval.\n\n' +
    'Notre équipe vous contactera sous 24h. / Our team will contact you within 24h.')
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTERED CUSTOMER (no restaurant)
// ─────────────────────────────────────────────────────────────────────────────
async function handleCustomer(
  from:     string,
  phone:    string,
  cmd:      string,
  customer: { id: string; name: string; phone: string; city: string },
): Promise<NextResponse> {
  if (cmd === 'aide' || cmd === 'help' || cmd === '') {
    await sendWhatsApp(from,
      `👋 *Bonjour ${customer.name}!* / *Hello ${customer.name}!*\n\n` +
      `📋 *Commandes disponibles / Available commands:*\n` +
      `🍽️ "commander" → Passer une commande / Place an order\n` +
      `📦 "mes commandes" → Voir vos commandes / View your orders\n` +
      `💳 "payer" → Payer une commande / Pay an order\n` +
      `🎫 "mes bons" → Voir vos bons / View vouchers\n` +
      `🎫 "bon CODE" → Ajouter un bon / Claim a code\n` +
      `🎉 "evenements" → Voir les événements / Browse events\n` +
      `⭐ "noter" → Noter votre dernier restaurant / Rate your last restaurant\n` +
      `🚩 "signaler" → Signaler un problème / Report an issue\n` +
      `🎟 "mes reservations" → Voir vos réservations / View reservations\n` +
      `🎟 "reserver XXXX" → Réserver un événement / Book an event\n` +
      `📢 "publier" → Publier un événement / Publish an event\n` +
      `📢 "mes evenements" → Voir vos événements publiés / View your events\n` +
      `📋 "reservations XXXX" → Voir les réservations d'un événement / View event reservations\n` +
      `🔔 "abonner" → Recevoir les nouveaux événements / Get new event alerts\n` +
      `🔕 "desabonner" → Arrêter les notifications / Stop notifications\n` +
      `📋 "mes abonnements" → Voir mes abonnements / View my subscriptions\n` +
      `📢 "diffuser" → Diffuser un message (payant) / Broadcast a message (paid)\n` +
      `🏪 "restaurant" → Inscrire votre restaurant / Register restaurant\n` +
      `❓ "aide" → Ce message / This message\n\n` +
      `🌍 Parcourez / Browse: ${BASE_URL}\n` +
      `🔑 Mon compte / My account: ${BASE_URL}/account`)
    return ok()
  }

  // Subscription commands. Handled before ordering so the verbs don't
  // collide with future ordering intents that happen to start with the same
  // tokens.
  const subResp = await handleSubscriptionCommand(from, cmd, customer)
  if (subResp) return subResp

  // "diffuser" / "broadcast" → punt to the website (compose UI is too
  // heavy for chat, per spec).
  if (cmd === 'diffuser' || cmd === 'broadcast') {
    await sendWhatsApp(from,
      `📢 *Diffuser un message / Broadcast a message*\n\n` +
      `Composez votre message sur le site / Compose on the website:\n` +
      `${BASE_URL}/account?tab=profile`)
    return ok()
  }

  // Payment retry — checked before ordering so "payer" doesn't get swallowed
  // by a future menu intent that happens to match the same token.
  const retry = await handlePaymentRetry(from, cmd, customer as OrderingCustomer)
  if (retry) return retry

  // Customer ordering intents (commander / mes commandes)
  const ordering = await handleOrderCommand(from, phone, cmd, customer as OrderingCustomer)
  if (ordering) return ordering

  if (cmd === 'restaurant' || cmd === 'inscription' || cmd === 'register') {
    await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'vendor', step: 1,
      data: { customer_id: customer.id }, expires_at: sessionExpiry(),
    })
    await sendWhatsApp(from,
      `🏪 *Inscription restaurant / Restaurant registration*\n\n` +
      'Quel est le *nom* de votre restaurant?\n' +
      'What is your *restaurant name*?\n\n' +
      '_Envoyez "annuler" pour annuler. / Send "cancel" to cancel._')
    return ok()
  }

  await sendWhatsApp(from,
    `Envoyez *aide* pour les options. / Send *help* for options.`)
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIPTION COMMANDS (customer-side)
// ─────────────────────────────────────────────────────────────────────────────
// "abonner" / "subscribe"                      → subscribe to all categories in their city
// "abonner concerts enfants"                   → subscribe only to those categories
// "desabonner" / "unsubscribe"                 → unsubscribe from ALL cities
// "mes abonnements" / "my subscriptions"       → list active subscriptions
//
// Returns NextResponse when handled, null otherwise so the caller falls
// through to the rest of the customer command tree.
const SUB_KEYWORD_TO_CATEGORY: Record<string, string> = {
  // Music / Concert
  'music':    'Music',   'musique':  'Music',
  'concert':  'Music',   'concerts': 'Music',
  // Food
  'food':     'Food',    'cuisine':  'Food',  'gastronomie': 'Food',
  // Sport
  'sport':    'Sport',   'sports':   'Sport',
  // Kids
  'enfants':  'Enfants', 'enfant':   'Enfants', 'kids': 'Enfants',
  // Art
  'art':      'Art',     'arts':     'Art',
  // Nightlife
  'nightlife':'Nightlife','nuit':    'Nightlife', 'club': 'Nightlife',
  // Business
  'business': 'Business','affaires': 'Business',
  // Bricolage/Club
  'bt':       'BT / Club', 'bricolage': 'BT / Club',
  // Other
  'autre':    'Autre',   'other':    'Autre',
}

function parseSubscribeCategories(tail: string): string[] | null {
  const tokens = tail.trim().toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) return null
  const cats = new Set<string>()
  for (const t of tokens) {
    const c = SUB_KEYWORD_TO_CATEGORY[t]
    if (c) cats.add(c)
  }
  return cats.size > 0 ? Array.from(cats) : null
}

async function handleSubscriptionCommand(
  from: string,
  cmd: string,
  customer: { id: string; name: string; phone: string; city: string },
): Promise<NextResponse | null> {
  const { writeAudit } = await import('@/lib/audit')

  // ── List
  if (cmd === 'mes abonnements' || cmd === 'my subscriptions' || cmd === 'mes abos') {
    const { data: subs } = await supabaseAdmin
      .from('event_subscriptions')
      .select('city, categories, is_active')
      .eq('customer_id', customer.id)
      .order('is_active', { ascending: false })

    const active = (subs ?? []).filter(s => s.is_active)
    if (active.length === 0) {
      await sendWhatsApp(from,
        `📋 Aucun abonnement actif. / No active subscriptions.\n\n` +
        `Envoyez "abonner" pour vous abonner aux événements à ${customer.city}.\n` +
        `Send "subscribe" to subscribe to events in ${customer.city}.`)
      return ok()
    }
    const lines = active.map(s => {
      const cats = s.categories && s.categories.length > 0
        ? `(${s.categories.join(', ')})`
        : '(toutes / all)'
      return `📍 ${s.city} ${cats}`
    })
    await sendWhatsApp(from,
      `🔔 *Mes abonnements / My subscriptions*\n\n${lines.join('\n')}\n\n` +
      `Envoyez "desabonner" pour tout arrêter. / Send "unsubscribe" to stop all.`)
    return ok()
  }

  // ── Unsubscribe (all cities)
  if (cmd === 'desabonner' || cmd === 'unsubscribe' || cmd === 'desabonnement') {
    const { data: rows } = await supabaseAdmin
      .from('event_subscriptions')
      .update({ is_active: false, unsubscribed_at: new Date().toISOString() })
      .eq('customer_id', customer.id)
      .eq('is_active', true)
      .select('id, city')

    for (const r of rows ?? []) {
      await writeAudit({
        action:          'subscription_cancelled',
        targetType:      'customer',
        targetId:        customer.id,
        performedBy:     customer.id,
        performedByType: 'customer',
        metadata: { subscription_id: r.id, city: r.city, via: 'whatsapp' },
      })
    }
    await sendWhatsApp(from,
      `🔕 Désabonné. Vous ne recevrez plus de notifications d'événements.\n` +
      `Unsubscribed. You won't receive event notifications anymore.\n\n` +
      `Envoyez "abonner" pour vous réabonner. / Send "subscribe" to opt back in.`)
    return ok()
  }

  // ── Subscribe (optionally with a category whitelist tail)
  const subMatch = cmd.match(/^(?:abonner|subscribe|abonnement|abonne)\s*(.*)$/i)
  if (subMatch && (cmd.startsWith('abonner') || cmd.startsWith('subscribe') || cmd.startsWith('abonne') || cmd === 'abonnement')) {
    if (!customer.city) {
      await sendWhatsApp(from,
        `❌ Ville inconnue. Mettez à jour votre ville sur ${BASE_URL}/account.\n` +
        `Unknown city. Update your city at ${BASE_URL}/account.`)
      return ok()
    }
    const tail = subMatch[1] ?? ''
    const categories = parseSubscribeCategories(tail)

    const { data, error } = await supabaseAdmin
      .from('event_subscriptions')
      .upsert({
        customer_id:     customer.id,
        city:            customer.city,
        categories,
        is_active:       true,
        unsubscribed_at: null,
      }, { onConflict: 'customer_id,city' })
      .select('id')
      .single()

    if (error || !data) {
      console.error('[whatsapp/subscribe] upsert error:', error?.message)
      await sendWhatsApp(from, `❌ Erreur. Réessayez. / Error. Retry.`)
      return ok()
    }

    await writeAudit({
      action:          'subscription_created',
      targetType:      'customer',
      targetId:        customer.id,
      performedBy:     customer.id,
      performedByType: 'customer',
      metadata: { subscription_id: data.id, city: customer.city, categories, via: 'whatsapp' },
    })

    const catLine = categories
      ? `Catégories: ${categories.join(', ')}\nCategories: ${categories.join(', ')}\n\n`
      : ''
    await sendWhatsApp(from,
      `🔔 Abonné aux événements à ${customer.city}!\n` +
      `${catLine}` +
      `Envoyez "desabonner" pour arrêter.\n\n` +
      `Subscribed to events in ${customer.city}! Send "unsubscribe" to stop.`)
    return ok()
  }

  return null
}
