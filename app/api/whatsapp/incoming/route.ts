import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp, pickLang, normalizeLang, getLangByPhone, type Lang } from '@/lib/whatsapp'
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

function categoryPrompt(lang: Lang): string {
  return pickLang(
    '📂 Catégorie?\n' +
    '1. Entrées\n2. Plats Principaux\n3. Grillades\n4. Boissons\n' +
    '5. Desserts\n6. Accompagnements\n7. Autre\n\n' +
    'Envoyez le numéro\n_(ou "passer" pour Plats Principaux)_',
    '📂 Category?\n' +
    '1. Starters\n2. Main Courses\n3. Grilled\n4. Drinks\n' +
    '5. Desserts\n6. Sides\n7. Other\n\n' +
    'Send the number\n_(or "skip" for Main Courses)_',
    lang)
}

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
  // Compress + re-encode via sharp before upload. WhatsApp media that
  // failed to decode (e.g. an unsupported HEIC) falls back to the
  // original bytes via safeCompress. Bucket name picks the kind:
  // restaurant-images → hero, menu-images → square thumb.
  const { safeCompress } = await import('@/lib/imageOptimizer')
  const kind =
    bucket === 'restaurant-images' ? 'restaurant_hero'
    : bucket === 'menu-images'     ? 'menu_item'
    : 'generic'
  const out  = await safeCompress(buffer, kind, contentType)
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${out.extension}`
  console.log(`[whatsapp] Uploading to Supabase bucket "${bucket}" at ${path} (${out.bytes}B)`)
  const { error } = await supabaseAdmin.storage
    .from(bucket).upload(path, out.buffer, {
      contentType:  out.contentType,
      cacheControl: '86400',  // 24h browser cache
      upsert:       false,
    })
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

  // ── Twilio signature validation ───────────────────────────────────────────
  // Twilio signs every webhook with HMAC-SHA1(url + sorted-form-fields)
  // using the account auth token. Without this check anyone with the
  // public webhook URL can spoof messages from any phone.
  // Skipped (with a console warning) when TWILIO_AUTH_TOKEN is missing,
  // so dev / sandbox without the variable keeps working.
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (authToken) {
    const sig = req.headers.get('x-twilio-signature') ?? ''
    const url = process.env.TWILIO_WEBHOOK_URL
      ?? `${process.env.NEXT_PUBLIC_BASE_URL ?? 'https://streetmenu.vercel.app'}/api/whatsapp/incoming`
    try {
      const twilio = (await import('twilio')).default
      const valid = twilio.validateRequest(authToken, sig, url, params)
      if (!valid) {
        console.warn('[whatsapp] Twilio signature validation FAILED — request rejected.')
        return new NextResponse(EMPTY_TWIML, { status: 403, headers: TWIML_HEADERS })
      }
    } catch (e) {
      console.error('[whatsapp] Twilio validateRequest threw:', (e as Error).message)
      return new NextResponse(EMPTY_TWIML, { status: 500, headers: TWIML_HEADERS })
    }
  } else {
    console.warn('[whatsapp] TWILIO_AUTH_TOKEN not set — skipping signature validation (dev mode).')
  }

  // ── Per-phone rate-limit ──────────────────────────────────────────────────
  // Prevents a flood of WhatsApp messages from a single phone from
  // tying up the route. 100/min is generous for a real user and
  // restrictive enough to bounce a script.
  const rawFrom = params['From'] ?? ''
  const phoneForLimit = rawFrom.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '') || 'anon'
  const { rateLimit } = await import('@/lib/rateLimit')
  const limited = rateLimit({
    key:      `whatsapp:${phoneForLimit}`,
    max:      100,
    windowMs: 60_000,
  })
  if (limited) {
    // 200 to Twilio so it doesn't retry; the user just doesn't get a
    // reply for this turn.
    console.warn(`[whatsapp] rate-limited ${phoneForLimit} — ${limited.retryAfterSec}s`)
    return ok()
  }

  // ── Sanitise body before any downstream use ───────────────────────────────
  const { sanitizeText } = await import('@/lib/sanitize')
  const rawBody2 = params['Body'] ?? ''
  const body      = sanitizeText(rawBody2, 1000).trim()

  const from      = rawFrom
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
    .from('customers').select('id, name, phone, city, status, deleted_at, preferred_language')
    .eq('phone', phone).maybeSingle()

  const accountLang = normalizeLang(customer?.preferred_language)
  if (customer?.deleted_at || customer?.status === 'deleted') {
    await sendWhatsApp(from, pickLang(
      'Votre compte a été supprimé.\nContactez le support si vous pensez que c\'est une erreur.',
      'Your account has been deleted.\nContact support if you think this is an error.', accountLang))
    return ok()
  }
  if (customer?.status === 'suspended') {
    await sendWhatsApp(from, pickLang(
      'Votre compte est suspendu. Contactez le support.',
      'Your account is suspended. Contact support.', accountLang))
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

  // Handle suspended/deleted restaurants on direct match. Vendor's language is
  // knowable here (their number is on file), so localize.
  const vendorStatusLang = directRestaurant ? await getLangByPhone(phone) : 'fr'
  if (directRestaurant?.deleted_at || directRestaurant?.status === 'deleted') {
    await sendWhatsApp(from, pickLang(
      'Ce restaurant a été supprimé.', 'This restaurant has been deleted.', vendorStatusLang))
    return ok()
  }
  if (directRestaurant?.status === 'suspended') {
    if (directRestaurant.suspended_by === 'vendor') {
      await sendWhatsApp(from, pickLang(
        `⏸️ *${directRestaurant.name}* est suspendu par vous-même.\nEnvoyez "reactiver" pour le réactiver.`,
        `⏸️ *${directRestaurant.name}* is suspended by you.\nSend "reactivate" to reactivate.`, vendorStatusLang))
    } else {
      await sendWhatsApp(from, pickLang(
        `⛔ *${directRestaurant.name}* est suspendu par l'administration.\nContactez le support.`,
        `⛔ *${directRestaurant.name}* is suspended by the admin.\nContact support.`, vendorStatusLang))
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
      await sendWhatsApp(from, pickLang(
        `✅ *${directRestaurant.name}* est maintenant actif!`,
        `✅ *${directRestaurant.name}* is now active!`, vendorStatusLang))
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
    return handlePendingVendor(from, phone, directRestaurant.name)
  }

  // Check team-based restaurant access
  if (activeRestaurants.length === 1) {
    return handleVendor(from, phone, body, cmd, hasPhoto, mediaUrl, activeRestaurants[0])
  }
  if (activeRestaurants.length > 1) {
    return handleMultiRestaurantSelection(from, phone, cmd, body, hasPhoto, mediaUrl, activeRestaurants)
  }

  if (customer) {
    return handleCustomer(from, phone, cmd, customer as Parameters<typeof handleCustomer>[3])
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
  const lang = await getLangByPhone(phone)

  // Commands "mes restaurants" or "my restaurants"
  if (cmd === 'mes restaurants' || cmd === 'my restaurants') {
    const lines = restaurants.map((r, i) => `${i + 1}. ${r.name} — ${r.status}`)
    await sendWhatsApp(from,
      pickLang(`🏪 *Vos restaurants:*`, `🏪 *Your restaurants:*`, lang) + `\n\n${lines.join('\n')}\n\n` +
      pickLang(`Envoyez le numéro pour sélectionner.`, `Send the number to select.`, lang))
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
    await sendWhatsApp(from, pickLang(
      `Envoyez un numéro entre 1 et ${restaurants.length}.`,
      `Send a number between 1 and ${restaurants.length}.`, lang))
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
    pickLang(`Vous avez ${restaurants.length} restaurants. Lequel?`, `You have ${restaurants.length} restaurants. Which one?`, lang) + `\n\n` +
    lines.join('\n') + '\n\n' +
    pickLang('Envoyez le numéro.', 'Send the number.', lang))
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
      .from('customers').select('id, name, phone, city, preferred_language')
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
      .from('customers').select('id, name, phone, city, preferred_language')
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
    const puLang = await getLangByPhone(phone)
    if (!hasPhoto) {
      await sendWhatsApp(from, pickLang(
        'Envoyez une photo, pas du texte.\n_Ou envoyez "annuler" pour annuler._',
        'Send a photo, not text.\n_Or send "cancel" to cancel._', puLang))
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
      await sendWhatsApp(from, pickLang('❌ Erreur lors de l\'envoi. Réessayez.', '❌ Error. Please retry.', puLang))
      return ok()
    }

    await supabaseAdmin.from('restaurants').update({ image_url: imageUrl }).eq('id', restaurant.id)
    await sendWhatsApp(from, pickLang(
      `✅ Photo de *${restaurant.name}* mise à jour! 📸\nVoir ici:\n${BASE_URL}/restaurant/${restaurant.id}`,
      `✅ Photo of *${restaurant.name}* updated! 📸\nSee it here:\n${BASE_URL}/restaurant/${restaurant.id}`, puLang))
    return ok()
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Menu-item category selection — set while a vendor has a pending dish
  // awaiting its category. Expires in 5 min (see sessionExpiry(5)).
  // ────────────────────────────────────────────────────────────────────────────
  if (user_type === 'menu_category') {
    const mcLang = await getLangByPhone(phone)
    const category = matchCategory(body)
    if (!category) {
      await sendWhatsApp(from,
        pickLang('❓ Choix invalide.', '❓ Invalid choice.', mcLang) + '\n\n' + categoryPrompt(mcLang))
      return ok()
    }

    const restaurantId: string | undefined = data.restaurant_id
    const dishName:     string | undefined = data.name
    const rawPrice:     string | undefined = data.price
    const photoUrl:     string | null      = (data.photo_url as string | null | undefined) ?? null
    const price = rawPrice ? parseInt(rawPrice, 10) : NaN

    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)

    if (!restaurantId || !dishName || isNaN(price) || price <= 0) {
      await sendWhatsApp(from, pickLang('❌ Session invalide. Réessayez.', '❌ Invalid session. Retry.', mcLang))
      return ok()
    }

    const { error } = await supabaseAdmin.from('menu_items').insert({
      restaurant_id: restaurantId, name: dishName, price,
      photo_url: photoUrl, category,
      is_available: true, is_daily_special: false, description: '',
    })
    if (error) {
      console.error('[whatsapp] menu insert error:', error.message)
      await sendWhatsApp(from, pickLang('❌ Erreur. Réessayez.', '❌ Error. Retry.', mcLang))
      return ok()
    }

    await sendWhatsApp(from,
      pickLang(`✅ *${dishName}* ajouté${photoUrl ? ' 📸' : ''}`, `✅ *${dishName}* added${photoUrl ? ' 📸' : ''}`, mcLang) + `\n` +
      pickLang(`Prix: ${price.toLocaleString()} FCFA`, `Price: ${price.toLocaleString()} FCFA`, mcLang) + `\n` +
      pickLang(`Catégorie: ${category}`, `Category: ${category}`, mcLang) + `\n\n` +
      pickLang(`💡 Envoyez 'menu' pour voir votre menu complet.`, `💡 Send 'menu' to see your full menu.`, mcLang))
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

  // Vendor's preferred language (by phone — falls back to FR). Drives the
  // single-language help text below; command names stay bilingual.
  const lang = await getLangByPhone(phone)

  // ── LANGUAGE TOGGLE ───────────────────────────────────────────────────────
  // Mirrors the customer-side toggle (see handleCustomer). Kept at the very top
  // so it can't fall through to the "Je n'ai pas compris" fallback below — that
  // was the bug: vendors/team members had no language handler at all. Persists
  // to the matching customer row by phone (harmless no-op if none exists) and
  // confirms in the target language.
  if (cmd === 'en' || cmd === 'english' || cmd === 'anglais') {
    console.log(`[whatsapp] command parsed: '${cmd}' → language switch (vendor, en)`)
    await supabaseAdmin.from('customers').update({ preferred_language: 'en' }).eq('phone', phone)
    await sendWhatsApp(from, `🌐 Language set to English. Send "fr" to switch back to French.`)
    return ok()
  }
  if (cmd === 'fr' || cmd === 'francais' || cmd === 'français' || cmd === 'french') {
    console.log(`[whatsapp] command parsed: '${cmd}' → language switch (vendor, fr)`)
    await supabaseAdmin.from('customers').update({ preferred_language: 'fr' }).eq('phone', phone)
    await sendWhatsApp(from, `🌐 Langue définie en français. Envoyez "en" pour passer à l'anglais.`)
    return ok()
  }

  // ── AIDE / HELP ──────────────────────────────────────────────────────────
  // Short list of the highest-frequency commands. The full reference lives
  // behind "aide+" / "help+" so this stays under Twilio's 1600-char body
  // limit even for an owner with all sections unlocked (error 21617).
  if (cmd === 'aide' || cmd === 'help' || cmd === '') {
    const en = lang === 'en'
    const lines: string[] = en
      ? [
          `👋 Hi! This is your Tchop & Ndjoka space for *${restaurant.name}* 🍽️ (role: ${teamRole})`,
          ``,
          `Here's how to run things from WhatsApp:`,
        ]
      : [
          `👋 Bonjour! Voici votre espace Tchop & Ndjoka pour *${restaurant.name}* 🍽️ (rôle: ${teamRole})`,
          ``,
          `Voici comment tout gérer depuis WhatsApp:`,
        ]
    if (canViewOrders) {
      lines.push(
        ``,
        en ? `📦 *Manage orders*` : `📦 *Gérer les commandes*`,
        en
          ? `Send "orders" to see what's coming in. Reply "ok XXXX" to confirm, "ready XXXX" when it's ready, "picked XXXX" once picked up.`
          : `Envoyez "commandes" pour voir ce qui arrive. Répondez "ok XXXX" pour confirmer, "pret XXXX" quand c'est prêt, "recupere XXXX" une fois récupéré.`,
      )
    }
    lines.push(
      ``,
      en ? `🍽️ *Your menu*` : `🍽️ *Votre menu*`,
      canEditMenu
        ? (en
            ? `Send "menu" to view it. To add a dish, send a photo with a caption like "Poulet DG - 3000".`
            : `Envoyez "menu" pour le voir. Pour ajouter un plat, envoyez une photo avec une légende du type "Poulet DG - 3000".`)
        : (en
            ? `Send "menu" to view the current menu.`
            : `Envoyez "menu" pour voir le menu actuel.`),
    )
    if (isOwner || isManager) {
      lines.push(
        ``,
        en ? `🕐 *Opening hours*` : `🕐 *Horaires d'ouverture*`,
        en
          ? `Send "open" or "close" to open/close now, "auto" to follow your schedule, "schedule" to view hours, "prep" for prep time.`
          : `Envoyez "ouvrir" ou "fermer" pour ouvrir/fermer maintenant, "auto" pour suivre votre horaire, "horaire" pour le voir, "temps" pour le temps de préparation.`,
      )
    }
    if (isOwner) {
      lines.push(
        ``,
        en ? `👥 *Your team*` : `👥 *Votre équipe*`,
        en
          ? `Send "team" to see members, or "add +237... manager" to add someone.`
          : `Envoyez "equipe" pour voir les membres, ou "ajouter +237... manager" pour ajouter quelqu'un.`,
      )
    }
    lines.push(
      ``,
      en ? `🌐 Switch to French → send 'fr'` : `🌐 Passer en anglais → envoyez 'en'`,
      ``,
      en ? `💡 Send "help+" for the full list of commands.` : `💡 Envoyez "aide+" pour la liste complète des commandes.`,
    )
    await sendWhatsApp(from, lines.join('\n'))
    return ok()
  }

  // ── AIDE+ / HELP+ — full command reference ────────────────────────────────
  // The exhaustive list. sendWhatsApp auto-splits when this exceeds 1500
  // chars, so we don't have to manually chunk by role.
  if (cmd === 'aide+' || cmd === 'help+' || cmd === 'aide plus' || cmd === 'help plus') {
    const en = lang === 'en'
    const canManage = isOwner || isManager
    const lines: string[] = [
      en ? `📋 *Full Guide — ${restaurant.name}*` : `📋 *Guide complet — ${restaurant.name}*`,
    ]

    // ── Menu ──
    lines.push('', en ? `🍽️ *Managing your menu*` : `🍽️ *Gérer votre menu*`)
    if (canEditMenu) {
      lines.push(
        en
          ? `To add a dish, send a photo with a caption like "Poulet DG - 3000". You can also update prices, mark items available/unavailable, or delete them.`
          : `Pour ajouter un plat, envoyez une photo avec une légende comme "Poulet DG - 3000". Vous pouvez aussi changer les prix, marquer un plat dispo/indispo, ou le supprimer.`,
        en
          ? `→ menu · price [name] [price] · available [name] · unavailable [name] · delete [name]`
          : `→ menu · prix [nom] [prix] · dispo [nom] · indispo [nom] · supprimer [nom]`,
      )
    } else {
      lines.push(
        en ? `View the current menu at any time.` : `Consultez le menu actuel à tout moment.`,
        en ? `→ menu` : `→ menu`,
      )
    }

    // ── Orders ──
    if (canViewOrders) {
      lines.push('', en ? `📦 *Handling orders*` : `📦 *Gérer les commandes*`,
        en
          ? `Check incoming orders and move them through the workflow: confirm → prepare → ready → picked up. You can also cancel orders or mark manual payments.`
          : `Consultez les commandes qui arrivent et faites-les avancer : confirmer → préparer → prêt → récupéré. Vous pouvez aussi annuler une commande ou marquer un paiement manuel.`,
        en
          ? `→ orders · ok [code] · preparing [code] · ready [code] · picked [code] · cancel [code] · paid [code] cash/mtn/orange`
          : `→ commandes · ok [code] · preparer [code] · pret [code] · recupere [code] · annuler [code] · paye [code] cash/mtn/orange`,
      )
    }

    // ── Hours & prep ──
    lines.push('', en ? `🕐 *Opening hours & prep time*` : `🕐 *Horaires & temps de préparation*`)
    if (canManage) {
      lines.push(
        en
          ? `View or change your schedule, manually open/close your restaurant, or set your estimated preparation time.`
          : `Consultez ou changez votre horaire, ouvrez/fermez votre restaurant manuellement, ou définissez votre temps de préparation estimé.`,
        en
          ? `→ schedule · open · close · auto · prep · prep [min] [max]`
          : `→ horaire · ouvrir · fermer · auto · temps · temps [min] [max]`,
      )
    } else {
      lines.push(
        en ? `View your schedule and estimated preparation time.` : `Consultez votre horaire et votre temps de préparation estimé.`,
        en ? `→ schedule · prep` : `→ horaire · temps`,
      )
    }

    // ── Team (owner only) ──
    if (isOwner) {
      lines.push('', en ? `👥 *Your team*` : `👥 *Votre équipe*`,
        en
          ? `See who's on your team, add managers or staff, send invitations, or remove members.`
          : `Voyez qui fait partie de votre équipe, ajoutez des managers ou du personnel, envoyez des invitations, ou retirez des membres.`,
        en
          ? `→ team · add +237... manager · invite +237... staff · invitations · remove +237...`
          : `→ equipe · ajouter +237... manager · inviter +237... staff · invitations · retirer +237...`,
      )
    }

    // ── Profile ──
    lines.push('', en ? `📷 *Restaurant profile*` : `📷 *Profil du restaurant*`)
    if (canEditMenu) {
      lines.push(
        en ? `Update your restaurant photo or view your public page.` : `Changez la photo de votre restaurant ou voyez votre page publique.`,
        en ? `→ profile photo · restaurant` : `→ photo restaurant · restaurant`,
      )
    } else {
      lines.push(
        en ? `View your public page.` : `Voyez votre page publique.`,
        en ? `→ restaurant` : `→ restaurant`,
      )
    }

    // ── Language ──
    lines.push('',
      en ? `🌐 Switch to French → send 'fr'` : `🌐 Passer en anglais → envoyez 'en'`)

    await sendWhatsApp(from, lines.join('\n'))
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
      await sendWhatsApp(from, pickLang(
        `Vous n'avez pas la permission de modifier le statut.`,
        `You don't have permission.`, lang))
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
      await sendWhatsApp(from, pickLang(`⚠️ Erreur: ${error.message}`, `⚠️ Error: ${error.message}`, lang))
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
      next === 'open'   ? pickLang(`🟢 *Ouvert manuellement*`, `🟢 *Manually open*`, lang) :
      next === 'closed' ? pickLang(`🔴 *Fermé manuellement*`, `🔴 *Manually closed*`, lang) :
      pickLang(`↩️ *Mode automatique*`, `↩️ *Auto mode*`, lang)
    const hint = next === null
      ? pickLang(`Le restaurant suit à nouveau l'horaire.`, `Following the schedule again.`, lang)
      : pickLang(`Envoyez "auto" pour revenir à l'horaire.`, `Send "auto" to follow the schedule.`, lang)
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
          ? pickLang(`🟢 *Ouvert (manuel)*`, `🟢 *Open (manual)*`, lang)
          : pickLang(`🔴 *Fermé (manuel)*`, `🔴 *Closed (manual)*`, lang))
      : (status.open
          ? pickLang(`🟢 *Ouvert (horaire)*`, `🟢 *Open (scheduled)*`, lang)
          : pickLang(`🔴 *Fermé (horaire)*`, `🔴 *Closed (scheduled)*`, lang))
    const nextLine = status.next_transition
      ? (status.next_transition.kind === 'opens'
          ? pickLang(`· Ouvre à ${status.next_transition.at}`, `· Opens at ${status.next_transition.at}`, lang)
          : pickLang(`· Ferme à ${status.next_transition.at}`, `· Closes at ${status.next_transition.at}`, lang))
      : ''
    const weekLines = formatHoursForDisplay(
      (hours ?? []).map(h => ({
        day_of_week: h.day_of_week,
        open_time:   String(h.open_time).slice(0, 5),
        close_time:  String(h.close_time).slice(0, 5),
        is_closed:   !!h.is_closed,
      })),
      lang,
    )
    await sendWhatsApp(from,
      `${statusLine} ${nextLine}\n${restaurant.name}\n\n` +
      pickLang(
        `🕐 Horaires:\n${weekLines.join('\n')}\n\n` +
        `Commandes:\n` +
        `🟢 "ouvrir" → Ouvrir manuellement\n` +
        `🔴 "fermer" → Fermer manuellement\n` +
        `↩️ "auto" → Suivre l'horaire`,
        `🕐 Hours:\n${weekLines.join('\n')}\n\n` +
        `Commands:\n` +
        `🟢 "ouvrir" → Manually open\n` +
        `🔴 "fermer" → Manually close\n` +
        `↩️ "auto" → Follow schedule`,
        lang))
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
          pickLang(`🕐 *Temps de préparation — ${restaurant.name}*`, `🕐 *Prep time — ${restaurant.name}*`, lang) + `\n\n` +
          (label
            ? pickLang(`Actuel: *${label}*`, `Current: *${label}*`, lang) + `\n\n`
            : pickLang(`Aucun temps défini.`, `No prep time set.`, lang) + `\n\n`) +
          (isOwner || isManager
            ? pickLang(
                `Pour changer:\n` +
                `"temps 20 35" → min 20 min, max 35 min\n\n` +
                `💡 La plupart des restaurants mettent ${PREP_TIME_DEFAULT_MIN}-${PREP_TIME_DEFAULT_MAX} min`,
                `To change:\n` +
                `"temps 20 35" → min 20 min, max 35 min\n\n` +
                `💡 Most restaurants set ${PREP_TIME_DEFAULT_MIN}-${PREP_TIME_DEFAULT_MAX} min`,
                lang)
            : pickLang(`Seuls le propriétaire et le manager peuvent le modifier.`, `Only the owner and manager can change it.`, lang)))
        return ok()
      }
      // Set path
      if (!(isOwner || isManager)) {
        await sendWhatsApp(from, pickLang(
          `Vous n'avez pas la permission de modifier le temps de préparation.`,
          `You don't have permission.`, lang))
        return ok()
      }
      const v = validatePrepTime(Number(prepSet![1]), Number(prepSet![2]))
      if (!v.ok) {
        await sendWhatsApp(from,
          `❌ ${v.error}\n\n` +
          pickLang(
            `Format: "temps 20 35" (min ≥ 5, max ≤ 120, min < max)`,
            `Format: "temps 20 35" (min ≥ 5, max ≤ 120, min < max)`, lang))
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
        await sendWhatsApp(from, pickLang(`⚠️ Erreur: ${error.message}`, `⚠️ Error: ${error.message}`, lang))
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
        pickLang(`✅ *Temps de préparation mis à jour*`, `✅ *Prep time updated*`, lang) + `\n` +
        `${restaurant.name}\n\n` +
        `🕐 ${v.min}-${v.max} min\n\n` +
        pickLang(`Affiché aux clients.`, `Shown to customers.`, lang))
      return ok()
    }
  }

  // ── TEAM MANAGEMENT (owner only) ─────────────────────────────────────────
  if (cmd === 'equipe' || cmd === 'team') {
    if (!isOwner) {
      await sendWhatsApp(from, pickLang(
        'Vous n\'avez pas la permission. Contactez le propriétaire.',
        'You don\'t have permission. Contact the owner.', lang))
      return ok()
    }
    const { data: members } = await supabaseAdmin
      .from('restaurant_team')
      .select('role, customers(name, phone)')
      .eq('restaurant_id', restaurant.id)
      .eq('status', 'active')

    if (!members || members.length === 0) {
      await sendWhatsApp(from, pickLang(
        `👥 *Équipe — ${restaurant.name}*\n\nAucun membre. Ajoutez avec:\n"ajouter +XXX manager"`,
        `👥 *Team — ${restaurant.name}*\n\nNo members. Add with:\n"add +XXX manager"`, lang))
      return ok()
    }
    const lines = members.map(m => {
      const c = m.customers as unknown as { name: string; phone: string }
      return `• ${c.name} (${c.phone}) — ${m.role}`
    })
    await sendWhatsApp(from, pickLang(`👥 *Équipe — ${restaurant.name}*`, `👥 *Team — ${restaurant.name}*`, lang) + `\n\n${lines.join('\n')}` + `\n\n` +
      pickLang(
        `💡 Envoyez 'ajouter +237... manager' pour ajouter un membre, 'retirer +237...' pour retirer.`,
        `💡 Send 'add +237... manager' to add a member, 'remove +237...' to remove.`, lang))
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
      await sendWhatsApp(from, pickLang('Vous n\'avez pas la permission.', 'You don\'t have permission.', lang))
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
      await sendWhatsApp(from, pickLang('❌ Numéro invalide.', '❌ Invalid phone number.', lang))
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

      await sendWhatsApp(from, pickLang(
        `✅ ${newMember.name} ajouté comme *${memberRole}*.`,
        `✅ ${newMember.name} added as *${memberRole}*.`, lang))
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
      await sendWhatsApp(from, pickLang(
        `⏳ Une invitation est déjà en attente pour ${memberPhone}.`,
        `⏳ A pending invitation already exists for ${memberPhone}.`, lang))
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
      await sendWhatsApp(from, pickLang('❌ Erreur. Réessayez.', '❌ Error. Retry.', lang))
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

    await sendWhatsApp(from, pickLang(
      `📨 Invitation envoyée à ${memberPhone}. En attente d'acceptation.`,
      `📨 Invitation sent to ${memberPhone}. Waiting for acceptance.`, lang))
    return ok()
  }

  // ── INVITATIONS: list pending ────────────────────────────────────────────
  if (cmd === 'invitations' || cmd === 'invitation') {
    if (!isOwner) {
      await sendWhatsApp(from, pickLang('Vous n\'avez pas la permission.', 'You don\'t have permission.', lang))
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
      await sendWhatsApp(from, pickLang(
        `📨 Aucune invitation en attente.\n\n` +
        `Invitez avec:\n"inviter +237XXX manager"`,
        `📨 No pending invitations.\n\n` +
        `Invite with:\n"inviter +237XXX manager"`, lang))
      return ok()
    }
    const lines = live.map((p, i) => {
      const daysAgo = Math.max(0, Math.floor((nowMs - new Date(p.created_at).getTime()) / 86_400_000))
      return `${i + 1}. ${p.phone} — ${p.role} — ${pickLang(`${daysAgo}j`, `${daysAgo}d`, lang)}`
    })
    await sendWhatsApp(from,
      pickLang(`📨 *Invitations en attente*`, `📨 *Pending invitations*`, lang) + `\n${lines.join('\n')}\n\n` +
      pickLang(`Annuler: "annuler invitation +237XXX"`, `Cancel: "annuler invitation +237XXX"`, lang))
    return ok()
  }

  // ── CANCEL INVITATION: "annuler invitation +237XXX" ──────────────────────
  const cancelInvMatch = body.match(/^(?:annuler\s+invitation|cancel\s+invitation)\s+(\+?[\d\s-]+)$/i)
  if (cancelInvMatch) {
    if (!isOwner) {
      await sendWhatsApp(from, pickLang('Vous n\'avez pas la permission.', 'You don\'t have permission.', lang))
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
      await sendWhatsApp(from, pickLang(
        '❌ Aucune invitation en attente pour ce numéro.',
        '❌ No pending invitation for this number.', lang))
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

    await sendWhatsApp(from, pickLang('Invitation annulée.', 'Invitation cancelled.', lang))
    return ok()
  }

  // ── REMOVE TEAM MEMBER: "retirer +237XXX" ────────────────────────────────
  const removeMemberMatch = body.match(/^(?:retirer|remove)\s+(\+?[\d\s-]+)$/i)
  if (removeMemberMatch) {
    if (!isOwner) {
      await sendWhatsApp(from, pickLang('Vous n\'avez pas la permission.', 'You don\'t have permission.', lang))
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
      await sendWhatsApp(from, pickLang(`❌ Numéro introuvable.`, `❌ Number not found.`, lang))
      return ok()
    }

    await supabaseAdmin.from('restaurant_team')
      .update({ status: 'removed' })
      .eq('restaurant_id', restaurant.id).eq('customer_id', memberCustomer.id)

    await sendWhatsApp(memberCustomer.phone,
      `👋 Vous avez été retiré de *${restaurant.name}*.\nYou have been removed from *${restaurant.name}*.`)
    await sendWhatsApp(from, pickLang(
      `✅ ${memberCustomer.name} retiré de l'équipe.`,
      `✅ ${memberCustomer.name} removed from team.`, lang))
    return ok()
  }

  // ── SUSPEND (owner only) ──────────────────────────────────────────────────
  if (cmd === 'suspendre' || cmd === 'suspend') {
    if (!isOwner) {
      await sendWhatsApp(from, pickLang('Vous n\'avez pas la permission.', 'You don\'t have permission.', lang))
      return ok()
    }
    await supabaseAdmin.from('restaurants').update({
      status: 'suspended', suspended_at: new Date().toISOString(), suspended_by: 'vendor',
    }).eq('id', restaurant.id)
    await sendWhatsApp(from, pickLang(
      `⏸️ *${restaurant.name}* suspendu. Envoyez "reactiver" pour réactiver.`,
      `⏸️ *${restaurant.name}* suspended. Send "reactiver" to reactivate.`, lang))
    return ok()
  }

  // ── START PHOTO-UPDATE STATE ─────────────────────────────────────────────
  if (cmd === 'photo restaurant' || cmd === 'photo profil' || cmd === 'profile photo' || cmd === 'photo') {
    await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'photo_update', step: 1, data: {},
      expires_at: sessionExpiry(5), // 5-minute window
    })
    await sendWhatsApp(from, pickLang(
      '📷 Envoyez la photo de votre restaurant maintenant.\n\n' +
      '_Expire dans 5 minutes._',
      '📷 Send your restaurant photo now.\n\n' +
      '_Expires in 5 minutes._', lang))
    return ok()
  }

  // ── VIEW MENU ────────────────────────────────────────────────────────────
  if (cmd === 'menu') {
    const { data: items } = await supabaseAdmin
      .from('menu_items').select('name, price, is_available')
      .eq('restaurant_id', restaurant.id).order('name')
    if (!items || items.length === 0) {
      await sendWhatsApp(from, pickLang(
        'Votre menu est vide.\n\n' +
        'Ajoutez un plat: "Ndolé - 2500"',
        'Your menu is empty.\n\n' +
        'Add a dish: "Ndolé - 2500"', lang))
      return ok()
    }
    const lines = items.map(i =>
      `${i.is_available ? '✅' : '❌'} ${i.name} — ${Number(i.price).toLocaleString()} FCFA`)
    const menuHint = canEditMenu
      ? `\n\n` + pickLang(
          `💡 Pour ajouter un plat, envoyez une photo avec 'Nom - Prix'. Envoyez 'prix NOM PRIX' pour modifier un prix.`,
          `💡 To add a dish, send a photo with 'Name - Price'. Send 'price NAME PRICE' to update a price.`, lang)
      : ``
    await sendWhatsApp(from,
      `🍽️ *Menu — ${restaurant.name}*\n` +
      pickLang(`(${items.length} plat${items.length > 1 ? 's' : ''})`, `(${items.length} dish${items.length > 1 ? 'es' : ''})`, lang) + `\n\n` +
      lines.join('\n') + menuHint)
    return ok()
  }

  // ── PENDING ORDERS ───────────────────────────────────────────────────────
  if ((cmd === 'commandes' || cmd === 'orders') && !canViewOrders) {
    await sendWhatsApp(from, pickLang(
      'Vous n\'avez pas la permission. Contactez le propriétaire.',
      'You don\'t have permission. Contact the owner.', lang))
    return ok()
  }
  if (cmd === 'commandes' || cmd === 'orders') {
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, customer_name, items, total_price, status, created_at')
      .eq('restaurant_id', restaurant.id)
      .in('status', ['pending', 'confirmed', 'preparing', 'ready'])
      .order('created_at', { ascending: false }).limit(60)
    if (!orders || orders.length === 0) {
      await sendWhatsApp(from, pickLang('Aucune commande en cours. ✅', 'No active orders. ✅', lang))
      return ok()
    }

    // Short code = last 4 hex of the (dash-stripped) UUID, the same value the
    // "ok XXXX" parser matches against (case-insensitive endsWith).
    const code = (id: string) => id.replace(/-/g, '').slice(-4).toUpperCase()
    const itemsOf = (o: { items: unknown }) => Array.isArray(o.items)
      ? (o.items as { name: string; quantity: number }[]).map(i => `${i.quantity}× ${i.name}`).join(', ')
      : ''
    const orderLine = (o: typeof orders[number]) =>
      `#${code(o.id)} — ${o.customer_name} — ${Number(o.total_price).toLocaleString()} FCFA — ${itemsOf(o)}`

    // Workflow order; each group shows only the next relevant action, with a
    // real code from that group's first order as a copy-pasteable example.
    const GROUPS: {
      status: string; emoji: string; hFr: string; hEn: string;
      hintFr: (ex: string) => string; hintEn: (ex: string) => string;
    }[] = [
      { status: 'pending',   emoji: '📦', hFr: 'En attente',     hEn: 'Pending',
        hintFr: ex => `💡 Pour confirmer une commande, répondez: ok [code] (ex: ok ${ex})`,
        hintEn: ex => `💡 To confirm an order, reply: ok [code] (e.g. ok ${ex})` },
      { status: 'confirmed', emoji: '✅', hFr: 'Confirmées',     hEn: 'Confirmed',
        hintFr: ex => `💡 Vous commencez à préparer? Répondez: preparer [code] (ex: preparer ${ex})`,
        hintEn: ex => `💡 Started cooking? Reply: preparing [code] (e.g. preparing ${ex})` },
      { status: 'preparing', emoji: '🍳', hFr: 'En préparation', hEn: 'Preparing',
        hintFr: ex => `💡 C'est prêt? Répondez: pret [code] (ex: pret ${ex})`,
        hintEn: ex => `💡 Food is ready? Reply: ready [code] (e.g. ready ${ex})` },
      { status: 'ready',     emoji: '🎉', hFr: 'Prêtes',         hEn: 'Ready',
        hintFr: ex => `💡 Le client a récupéré? Répondez: recupere [code] (ex: recupere ${ex})`,
        hintEn: ex => `💡 Customer picked up? Reply: picked [code] (e.g. picked ${ex})` },
    ]

    // Build with up to `perGroup` orders per status, the rest folded into a
    // "… and X more" line. Default to 5 most recent; shrink only if the body
    // would blow Twilio's 1500-char limit (busy day, all statuses full).
    const title = pickLang(`🛒 *Commandes en cours — ${restaurant.name}*`, `🛒 *Active orders — ${restaurant.name}*`, lang)
    const buildMessage = (perGroup: number): string => {
      const sections = GROUPS.flatMap(g => {
        const all = orders.filter(o => o.status === g.status)
        if (all.length === 0) return []
        const shown = all.slice(0, perGroup)
        const extra = all.length - shown.length
        const more = extra > 0
          ? `\n` + pickLang(`… et ${extra} autre${extra > 1 ? 's' : ''}`, `… and ${extra} more`, lang)
          : ``
        const exampleCode = code(all[0].id)
        return [
          `${g.emoji} *${pickLang(g.hFr, g.hEn, lang)} (${all.length}):*\n` +
          shown.map(orderLine).join('\n') + more + `\n` +
          pickLang(g.hintFr(exampleCode), g.hintEn(exampleCode), lang),
        ]
      })
      return `${title}\n\n${sections.join('\n\n')}`
    }
    let message = buildMessage(5)
    for (let per = 4; per >= 1 && message.length > 1500; per--) message = buildMessage(per)

    await sendWhatsApp(from, message)
    return ok()
  }

  // ── UPDATE PRICE: "prix Ndolé 3000" or "price Ndolé 3000" ───────────────
  const priceMatch = body.match(/^(?:prix|price)\s+(.+?)\s+(\d[\d\s]*)$/i)
  if (priceMatch && !canEditMenu) {
    await sendWhatsApp(from, pickLang(
      'Vous n\'avez pas la permission. Contactez le propriétaire.',
      'You don\'t have permission. Contact the owner.', lang))
    return ok()
  }
  if (priceMatch) {
    const itemName = priceMatch[1].trim()
    const newPrice = parseInt(priceMatch[2].replace(/\s/g, ''), 10)
    if (isNaN(newPrice) || newPrice <= 0) {
      await sendWhatsApp(from, pickLang('Prix invalide. Ex: prix Ndolé 3000', 'Invalid price. Ex: prix Ndolé 3000', lang))
      return ok()
    }
    const item = await findMenuItem(restaurant.id, itemName)
    if (!item) {
      await sendWhatsApp(from, pickLang(
        `❌ "${itemName}" introuvable dans votre menu.`,
        `❌ "${itemName}" not found in your menu.`, lang))
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
    await sendWhatsApp(from, pickLang('Vous n\'avez pas la permission.', 'You don\'t have permission.', lang))
    return ok()
  }
  if (dispoMatch) {
    const itemName = dispoMatch[1].trim()
    const item = await findMenuItem(restaurant.id, itemName)
    if (!item) {
      await sendWhatsApp(from, pickLang(`❌ "${itemName}" introuvable.`, `❌ "${itemName}" not found.`, lang))
      return ok()
    }
    await supabaseAdmin.from('menu_items').update({ is_available: true }).eq('id', item.id)
    await sendWhatsApp(from, pickLang(`✅ *${item.name}* marqué disponible`, `✅ *${item.name}* marked available`, lang))
    return ok()
  }

  // ── MARK UNAVAILABLE: "indispo Ndolé" or "unavailable Ndolé" ────────────
  const indispoMatch = body.match(/^(?:indispo|unavailable)\s+(.+)$/i)
  if (indispoMatch && !canEditMenu) {
    await sendWhatsApp(from, pickLang('Vous n\'avez pas la permission.', 'You don\'t have permission.', lang))
    return ok()
  }
  if (indispoMatch) {
    const itemName = indispoMatch[1].trim()
    const item = await findMenuItem(restaurant.id, itemName)
    if (!item) {
      await sendWhatsApp(from, pickLang(`❌ "${itemName}" introuvable.`, `❌ "${itemName}" not found.`, lang))
      return ok()
    }
    await supabaseAdmin.from('menu_items').update({ is_available: false }).eq('id', item.id)
    await sendWhatsApp(from, pickLang(`❌ *${item.name}* marqué indisponible`, `❌ *${item.name}* marked unavailable`, lang))
    return ok()
  }

  // ── DELETE ITEM: "supprimer Ndolé" or "delete Ndolé" ────────────────────
  const deleteMatch = body.match(/^(?:supprimer|delete)\s+(.+)$/i)
  if (deleteMatch && !canEditMenu) {
    await sendWhatsApp(from, pickLang('Vous n\'avez pas la permission.', 'You don\'t have permission.', lang))
    return ok()
  }
  if (deleteMatch) {
    const itemName = deleteMatch[1].trim()
    const item = await findMenuItem(restaurant.id, itemName)
    if (!item) {
      await sendWhatsApp(from, pickLang(`❌ "${itemName}" introuvable.`, `❌ "${itemName}" not found.`, lang))
      return ok()
    }
    await supabaseAdmin.from('menu_items').delete().eq('id', item.id)
    await sendWhatsApp(from, pickLang(`🗑️ *${item.name}* supprimé du menu`, `🗑️ *${item.name}* removed from menu`, lang))
    return ok()
  }

  // ── PHOTO WITH CAPTION ───────────────────────────────────────────────────
  if (hasPhoto && !canEditMenu) {
    await sendWhatsApp(from, pickLang(
      'Vous n\'avez pas la permission de modifier le menu.',
      'You don\'t have permission to edit the menu.', lang))
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
        await sendWhatsApp(from, pickLang('Format invalide. Ex: Ndolé - 2500', 'Invalid format. Ex: Ndolé - 2500', lang))
        return ok()
      }
      const media    = await downloadTwilioMedia(mediaUrl)
      const photoUrl = media ? await uploadToStorage('menu-images', media.buffer, media.contentType) : null

      const category = threePart ? matchCategory(match[3]) : null
      if (threePart && !category) {
        await sendWhatsApp(from,
          pickLang(`❓ Catégorie "${match[3].trim()}" non reconnue.`, `❓ Unknown category "${match[3].trim()}".`, lang) + `\n\n` +
          categoryPrompt(lang))
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
          await sendWhatsApp(from, pickLang('❌ Erreur. Réessayez.', '❌ Error. Retry.', lang))
          return ok()
        }
        await sendWhatsApp(from,
          pickLang(`✅ *${dishName}* ajouté${photoUrl ? ' 📸' : ''}`, `✅ *${dishName}* added${photoUrl ? ' 📸' : ''}`, lang) + `\n` +
          pickLang(`Prix: ${price.toLocaleString()} FCFA`, `Price: ${price.toLocaleString()} FCFA`, lang) + `\n` +
          pickLang(`Catégorie: ${category}`, `Category: ${category}`, lang) + `\n\n` +
          pickLang(`💡 Envoyez 'menu' pour voir votre menu complet.`, `💡 Send 'menu' to see your full menu.`, lang))
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
        categoryPrompt(lang))
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
          await sendWhatsApp(from, pickLang(`📸 Photo de *${item.name}* mise à jour!`, `📸 Photo of *${item.name}* updated!`, lang))
        } else {
          await sendWhatsApp(from, pickLang('❌ Erreur upload photo. Réessayez.', '❌ Photo upload error. Retry.', lang))
        }
        return ok()
      }
    }

    // No usable caption
    await sendWhatsApp(from, pickLang(
      'Ajoutez le nom et le prix dans la légende.\n' +
      'Ex: *Ndolé - 2500*',
      'Add the name and price in the caption.\n' +
      'Ex: *Ndolé - 2500*', lang))
    return ok()
  }

  // ── ADD ITEM (text only, no photo) ───────────────────────────────────────
  // 3-part "Ndolé - 2500 - Plats" → insert directly.
  // 2-part "Ndolé - 2500"         → prompt for category.
  const textThreePart = body.match(/^(.+?)\s*[-–—]\s*([\d\s]+)\s*[-–—]\s*(.+?)\s*$/)
  const textTwoPart   = textThreePart ? null
    : body.match(/^(.+?)\s*[-–—]\s*([\d\s]+)\s*$/)
  if ((textThreePart || textTwoPart) && !canEditMenu) {
    await sendWhatsApp(from, pickLang(
      'Vous n\'avez pas la permission de modifier le menu.',
      'You don\'t have permission.', lang))
    return ok()
  }
  if (textThreePart || textTwoPart) {
    const match    = (textThreePart ?? textTwoPart) as RegExpMatchArray
    const dishName = match[1].trim()
    const price    = parseInt(match[2].replace(/\s/g, ''), 10)
    if (!dishName || isNaN(price) || price <= 0) {
      await sendWhatsApp(from, pickLang('Format invalide. Ex: Ndolé - 2500', 'Invalid format. Ex: Ndolé - 2500', lang))
      return ok()
    }
    const category = textThreePart ? matchCategory(match[3]) : null

    if (textThreePart && !category) {
      await sendWhatsApp(from,
        pickLang(`❓ Catégorie "${match[3].trim()}" non reconnue.`, `❓ Unknown category "${match[3].trim()}".`, lang) + `\n\n` +
        categoryPrompt(lang))
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
        await sendWhatsApp(from, pickLang('❌ Erreur. Réessayez.', '❌ Error. Retry.', lang))
        return ok()
      }
      await sendWhatsApp(from,
        pickLang(`✅ *${dishName}* ajouté au menu`, `✅ *${dishName}* added to the menu`, lang) + `\n` +
        pickLang(`Prix: ${price.toLocaleString()} FCFA`, `Price: ${price.toLocaleString()} FCFA`, lang) + `\n` +
        pickLang(`Catégorie: ${category}`, `Category: ${category}`, lang) + `\n\n` +
        pickLang(
          '📸 Envoyez une photo avec la même légende pour ajouter une image.',
          '📸 Send a photo with the same caption to add an image.', lang) + `\n\n` +
        pickLang(`💡 Envoyez 'menu' pour voir votre menu complet.`, `💡 Send 'menu' to see your full menu.`, lang))
      return ok()
    }

    // 2-part flow: stash pending item + prompt for category.
    await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'menu_category', step: 1,
      data: { restaurant_id: restaurant.id, name: dishName, price: String(price), photo_url: null },
      expires_at: sessionExpiry(5),
    })
    await sendWhatsApp(from,
      `✅ *${dishName}* (${price.toLocaleString()} FCFA)\n\n` + categoryPrompt(lang))
    return ok()
  }

  // ── VENDOR ORDER ACTIONS: ok XXXX / pret XXXX / annuler XXXX ─────────────
  if (canViewOrders) {
    const actionResp = await handleVendorOrderAction(from, body, { id: restaurant.id, name: restaurant.name })
    if (actionResp) return actionResp
  }

  // ── Unknown ──────────────────────────────────────────────────────────────
  await sendWhatsApp(from, pickLang(
    'Je n\'ai pas compris. Envoyez *aide* pour la liste des commandes.',
    'I didn\'t understand. Send *help* for the list of commands.', lang))
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING VENDOR
// ─────────────────────────────────────────────────────────────────────────────
async function handlePendingVendor(from: string, phone: string, restaurantName: string): Promise<NextResponse> {
  const lang = await getLangByPhone(phone)
  await sendWhatsApp(from, pickLang(
    `⏳ *${restaurantName}* est en attente de validation.\n\n` +
    'Notre équipe vous contactera sous 24h.',
    `⏳ *${restaurantName}* is pending approval.\n\n` +
    'Our team will contact you within 24h.', lang))
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTERED CUSTOMER (no restaurant)
// ─────────────────────────────────────────────────────────────────────────────
async function handleCustomer(
  from:     string,
  phone:    string,
  cmd:      string,
  customer: { id: string; name: string; phone: string; city: string; preferred_language?: string | null },
): Promise<NextResponse> {
  const lang: Lang = normalizeLang(customer.preferred_language)

  // ── LANGUAGE TOGGLE ───────────────────────────────────────────────────────
  // Stays at the top of the handler so it can't get swallowed by a fuzzy
  // intent match further down. Persists to customers.preferred_language and
  // confirms in the *target* language so the user immediately sees the
  // switch took effect.
  if (cmd === 'en' || cmd === 'english' || cmd === 'anglais') {
    console.log(`[whatsapp] command parsed: '${cmd}' → language switch (customer, en)`)
    await supabaseAdmin.from('customers')
      .update({ preferred_language: 'en' })
      .eq('id', customer.id)
    await sendWhatsApp(from, `🌐 Language set to English. Send "fr" to switch back to French.`)
    return ok()
  }
  if (cmd === 'fr' || cmd === 'francais' || cmd === 'français' || cmd === 'french') {
    console.log(`[whatsapp] command parsed: '${cmd}' → language switch (customer, fr)`)
    await supabaseAdmin.from('customers')
      .update({ preferred_language: 'fr' })
      .eq('id', customer.id)
    await sendWhatsApp(from, `🌐 Langue définie en français. Envoyez "en" pour passer à l'anglais.`)
    return ok()
  }

  if (cmd === 'aide' || cmd === 'help' || cmd === '') {
    // Short list of the highest-frequency commands. The full reference is
    // behind "aide+" / "help+" so this stays under Twilio's 1600-char body
    // limit (error 21617). Single-language per the customer's preferred_language.
    await sendWhatsApp(from, lang === 'en'
      ? `👋 Hello ${customer.name}! Welcome to Tchop & Ndjoka 🍽️\n\n` +
        `Here's what you can do:\n\n` +
        `🍽️ *Order food*\n` +
        `Send "order" and I'll guide you through choosing a restaurant and placing an order.\n\n` +
        `📦 *Track your orders*\n` +
        `Send "my orders" to check the status of your current orders.\n\n` +
        `🎉 *Discover events*\n` +
        `Send "events" to see what's happening in your city.\n\n` +
        `🎫 *Use a discount code*\n` +
        `Send "my vouchers" to see your available promo codes.\n\n` +
        `🔔 *Get event alerts*\n` +
        `Send "subscribe" to be notified about new events.\n\n` +
        `🏪 *Own a restaurant?*\n` +
        `Send "restaurant" to register it on the platform.\n\n` +
        `🌐 Switch to French → send 'fr'\n\n` +
        `💡 Send "help+" to see all advanced commands.`
      : `👋 Bonjour ${customer.name}! Bienvenue sur Tchop & Ndjoka 🍽️\n\n` +
        `Voici ce que vous pouvez faire ici:\n\n` +
        `🍽️ *Commander à manger*\n` +
        `Envoyez "commander" et je vous guiderai pour choisir un restaurant et passer commande.\n\n` +
        `📦 *Suivre vos commandes*\n` +
        `Envoyez "mes commandes" pour voir où en sont vos commandes en cours.\n\n` +
        `🎉 *Découvrir les événements*\n` +
        `Envoyez "evenements" pour voir ce qui se passe dans votre ville.\n\n` +
        `🎫 *Utiliser un bon de réduction*\n` +
        `Envoyez "mes bons" pour voir vos codes promo disponibles.\n\n` +
        `🔔 *Recevoir des alertes*\n` +
        `Envoyez "abonner" pour être notifié des nouveaux événements.\n\n` +
        `🏪 *Vous avez un restaurant?*\n` +
        `Envoyez "restaurant" pour l'inscrire sur la plateforme.\n\n` +
        `🌐 Passer en anglais → envoyez 'en'\n\n` +
        `💡 Envoyez "aide+" pour voir toutes les commandes avancées.`)
    return ok()
  }

  // ── AIDE+ / HELP+ — full command reference ────────────────────────────────
  // The exhaustive list. sendWhatsApp auto-splits when this exceeds 1500
  // chars, so the customer reliably gets every command listed.
  if (cmd === 'aide+' || cmd === 'help+' || cmd === 'aide plus' || cmd === 'help plus') {
    const en = lang === 'en'
    const lines: string[] = en
      ? [
          `📋 *Full Guide — Tchop & Ndjoka*`,
          ``,
          `🍽️ *Ordering food*`,
          `Browse restaurants, place orders, track them, and pay. You can also use discount codes at checkout.`,
          `→ order · my orders · pay · my vouchers · voucher [CODE]`,
          ``,
          `⭐ *Ratings & feedback*`,
          `Rate your experience after a delivered order, or report a problem.`,
          `→ rate · report`,
          ``,
          `🎉 *Events*`,
          `Discover events in your city, book tickets, and manage your reservations.`,
          `→ events · book [code] · my reservations`,
          ``,
          `📢 *Publishing events*`,
          `Submit your own events, manage reservations, set ticket tiers, and control bookings.`,
          `→ publish · my events · reservations [code] · tiers [code] · add tier [code] name price`,
          `→ open/close reservations [code] · confirm/reject reservation [code]`,
          ``,
          `🔔 *Notifications*`,
          `Get alerted when new events are published in your city. You can also broadcast messages to subscribers (paid).`,
          `→ subscribe · unsubscribe · my subscriptions · broadcast`,
          ``,
          `🏪 *Own a restaurant?*`,
          `Register your restaurant on the platform.`,
          `→ restaurant`,
          ``,
          `🌐 Switch to French → send 'fr'`,
          ``,
          `🌍 Browse: ${BASE_URL}`,
        ]
      : [
          `📋 *Guide complet — Tchop & Ndjoka*`,
          ``,
          `🍽️ *Commander à manger*`,
          `Parcourez les restaurants, passez commande, suivez vos commandes et payez. Vous pouvez aussi utiliser un bon de réduction au paiement.`,
          `→ commander · mes commandes · payer · mes bons · bon [CODE]`,
          ``,
          `⭐ *Avis & signalements*`,
          `Notez votre expérience après une commande livrée, ou signalez un problème.`,
          `→ noter · signaler`,
          ``,
          `🎉 *Événements*`,
          `Découvrez les événements de votre ville, réservez des billets et gérez vos réservations.`,
          `→ evenements · reserver [code] · mes reservations`,
          ``,
          `📢 *Publier des événements*`,
          `Soumettez vos propres événements, gérez les réservations, définissez des tarifs et contrôlez les réservations.`,
          `→ publier · mes evenements · reservations [code] · tarifs [code] · ajouter tarif [code] nom prix`,
          `→ ouvrir/fermer reservations [code] · confirmer/rejeter reservation [code]`,
          ``,
          `🔔 *Notifications*`,
          `Soyez alerté quand de nouveaux événements sont publiés dans votre ville. Vous pouvez aussi diffuser des messages aux abonnés (payant).`,
          `→ abonner · desabonner · mes abonnements · diffuser`,
          ``,
          `🏪 *Vous avez un restaurant?*`,
          `Inscrivez votre restaurant sur la plateforme.`,
          `→ restaurant`,
          ``,
          `🌐 Passer en anglais → envoyez 'en'`,
          ``,
          `🌍 Parcourez: ${BASE_URL}`,
        ]
    await sendWhatsApp(from, lines.join('\n'))
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
    await sendWhatsApp(from, pickLang(
      `📢 *Diffuser un message*\n\n` +
      `Composez votre message sur le site:\n` +
      `${BASE_URL}/account?tab=profile`,
      `📢 *Broadcast a message*\n\n` +
      `Compose on the website:\n` +
      `${BASE_URL}/account?tab=profile`, lang))
    return ok()
  }

  // "promouvoir" / "promote" → same: too complex for chat, redirect.
  if (cmd === 'promouvoir' || cmd === 'promote') {
    await sendWhatsApp(from, pickLang(
      `📢 *Promouvoir*\n\n` +
      `Créez votre promotion sur le site:\n` +
      `${BASE_URL}/account?tab=profile`,
      `📢 *Promote*\n\n` +
      `Create your promotion on the website:\n` +
      `${BASE_URL}/account?tab=profile`, lang))
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
    await sendWhatsApp(from, pickLang(
      `🏪 *Inscription restaurant*\n\n` +
      'Quel est le *nom* de votre restaurant?\n\n' +
      '_Envoyez "annuler" pour annuler._',
      `🏪 *Restaurant registration*\n\n` +
      'What is your *restaurant name*?\n\n' +
      '_Send "cancel" to cancel._', lang))
    return ok()
  }

  await sendWhatsApp(from, pickLang(
    `Envoyez *aide* pour les options.`,
    `Send *help* for options.`,
    lang,
  ))
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
  // Concert (legacy "Music" + "Concert" both land here now)
  'concert':  'Concert', 'concerts': 'Concert',
  'music':    'Concert', 'musique':  'Concert',
  // Festival (legacy "Nightlife" → "Festival")
  'festival': 'Festival', 'festivals': 'Festival',
  'nightlife':'Festival', 'nuit':     'Festival',
  // BT/Club (merged)
  'bt':       'BT/Club', 'club':     'BT/Club', 'clubs': 'BT/Club',
  'bricolage':'BT/Club',
  // Sport
  'sport':    'Sport',   'sports':   'Sport',
  // Culture (legacy "Art" → "Culture")
  'culture':  'Culture', 'cultures': 'Culture',
  'art':      'Culture', 'arts':     'Culture',
  // Gastronomie (legacy "Food" → "Gastronomie")
  'gastronomie': 'Gastronomie',
  'food':     'Gastronomie', 'cuisine': 'Gastronomie',
  // Kids
  'enfants':  'Enfants', 'enfant':   'Enfants', 'kids': 'Enfants',
  // Business
  'business': 'Business','affaires': 'Business',
  // Other
  'autre':    'Autre',   'other':    'Autre',
}

// Tokens that explicitly mean "all categories". When any of these are
// present in the tail (or the tail is empty) we return null so the
// caller treats it as "subscribe to everything".
const SUB_ALL_TOKENS = new Set(['tout', 'tous', 'toutes', 'all', 'everything'])

function parseSubscribeCategories(tail: string): string[] | null {
  const tokens = tail.trim().toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) return null
  if (tokens.some(t => SUB_ALL_TOKENS.has(t))) return null
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
  customer: { id: string; name: string; phone: string; city: string; preferred_language?: string | null },
): Promise<NextResponse | null> {
  const { writeAudit } = await import('@/lib/audit')
  const lang = normalizeLang(customer.preferred_language)

  // ── List
  if (cmd === 'mes abonnements' || cmd === 'my subscriptions' || cmd === 'mes abos') {
    const { data: subs } = await supabaseAdmin
      .from('event_subscriptions')
      .select('city, categories, is_active')
      .eq('customer_id', customer.id)
      .order('is_active', { ascending: false })

    const active = (subs ?? []).filter(s => s.is_active)
    if (active.length === 0) {
      await sendWhatsApp(from, pickLang(
        `📋 Aucun abonnement actif.\n\nEnvoyez "abonner" pour vous abonner aux événements à ${customer.city}.`,
        `📋 No active subscriptions.\n\nSend "subscribe" to subscribe to events in ${customer.city}.`,
        lang,
      ))
      return ok()
    }
    const allLabel = pickLang('toutes', 'all', lang)
    const lines = active.map(s => {
      const cats = s.categories && s.categories.length > 0
        ? `(${s.categories.join(', ')})`
        : `(${allLabel})`
      return `📍 ${s.city} ${cats}`
    })
    await sendWhatsApp(from, pickLang(
      `🔔 *Mes abonnements*\n\n${lines.join('\n')}\n\nEnvoyez "desabonner" pour tout arrêter.`,
      `🔔 *My subscriptions*\n\n${lines.join('\n')}\n\nSend "unsubscribe" to stop all.`,
      lang,
    ))
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
    await sendWhatsApp(from, pickLang(
      `🔕 Désabonné. Vous ne recevrez plus de notifications d'événements.\n\nEnvoyez "abonner" pour vous réabonner.`,
      `🔕 Unsubscribed. You won't receive event notifications anymore.\n\nSend "subscribe" to opt back in.`,
      lang,
    ))
    return ok()
  }

  // ── Subscribe (optionally with a category whitelist tail)
  const subMatch = cmd.match(/^(?:abonner|subscribe|abonnement|abonne)\s*(.*)$/i)
  if (subMatch && (cmd.startsWith('abonner') || cmd.startsWith('subscribe') || cmd.startsWith('abonne') || cmd === 'abonnement')) {
    if (!customer.city) {
      await sendWhatsApp(from, pickLang(
        `❌ Ville inconnue. Mettez à jour votre ville sur ${BASE_URL}/account.`,
        `❌ Unknown city. Update your city at ${BASE_URL}/account.`,
        lang,
      ))
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
      await sendWhatsApp(from, pickLang(`❌ Erreur. Réessayez.`, `❌ Error. Retry.`, lang))
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

    // Single-language confirmation per the recipient's preferred_language.
    const cats = categories
      ? categories.join(', ')
      : pickLang('toutes catégories', 'all categories', lang)
    await sendWhatsApp(from,
      pickLang(`🔔 Abonné: ${cats} à ${customer.city}`, `🔔 Subscribed: ${cats} in ${customer.city}`, lang) + `\n\n` +
      pickLang(
        `💡 Envoyez 'mes abonnements' pour gérer vos alertes, ou 'desabonner' pour arrêter.`,
        `💡 Send 'my subscriptions' to manage alerts, or 'unsubscribe' to stop.`, lang))
    return ok()
  }

  return null
}
