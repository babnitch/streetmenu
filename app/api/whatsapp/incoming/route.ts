import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

// ── Empty TwiML ack ───────────────────────────────────────────────────────────
const EMPTY_TWIML   = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
const TWIML_HEADERS = { 'Content-Type': 'text/xml' }
function ok(): NextResponse {
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS })
}

// ── Phone normalisation ──────────────────────────────────────────────────────
function normalisePhone(raw: string): string {
  return raw.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '')
}

// ── City / cuisine helpers ───────────────────────────────────────────────────
const CITY_MAP: Record<string, string> = {
  'yaoundé': 'Yaoundé', 'yaounde': 'Yaoundé', '1': 'Yaoundé',
  'abidjan': 'Abidjan', '2': 'Abidjan',
  'dakar':   'Dakar',   '3': 'Dakar',
  'lomé':    'Lomé', 'lome': 'Lomé', '4': 'Lomé',
}
function parseCity(input: string): string | null {
  return CITY_MAP[input.toLowerCase().trim()] ?? null
}

const CUISINE_MAP: Record<string, string> = {
  'camerounaise': 'Camerounaise', '1': 'Camerounaise',
  'sénégalaise': 'Sénégalaise', 'senegalaise': 'Sénégalaise', '2': 'Sénégalaise',
  'ivoirienne': 'Ivoirienne', '3': 'Ivoirienne',
  'fast-food': 'Fast-food', 'fast food': 'Fast-food', 'fastfood': 'Fast-food', '4': 'Fast-food',
  'grillades': 'Grillades', '5': 'Grillades',
  'autre': 'Autre', '6': 'Autre',
}
function parseCuisine(input: string): string | null {
  return CUISINE_MAP[input.toLowerCase().trim()] ?? null
}

// ── Download Twilio media ─────────────────────────────────────────────────────
async function downloadTwilioMedia(mediaUrl: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(mediaUrl, {
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.TWILIO_API_KEY_SID}:${process.env.TWILIO_API_KEY_SECRET}`
        ).toString('base64')}`,
      },
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const buffer      = Buffer.from(await res.arrayBuffer())
    return { buffer, contentType }
  } catch { return null }
}

// ── Upload to Supabase Storage ────────────────────────────────────────────────
async function uploadMenuImage(buffer: Buffer, contentType: string): Promise<string | null> {
  const ext  = contentType.split('/')[1]?.split(';')[0] ?? 'jpg'
  const path = `menu-images/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const { error } = await supabaseAdmin.storage
    .from('menu-images').upload(path, buffer, { contentType, upsert: false })
  if (error) { console.error('[whatsapp] storage error:', error.message); return null }
  const { data } = supabaseAdmin.storage.from('menu-images').getPublicUrl(path)
  return data.publicUrl
}

// ── Base URL ──────────────────────────────────────────────────────────────────
const BASE_URL = 'https://streetmenu.vercel.app'

// ── Session expiry helpers ───────────────────────────────────────────────────
function sessionExpiry(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const params  = Object.fromEntries(new URLSearchParams(rawBody))

  const from      = params['From'] ?? ''
  const body      = (params['Body'] ?? '').trim()
  const numMedia  = parseInt(params['NumMedia'] ?? '0', 10)
  const mediaUrl  = params['MediaUrl0'] ?? ''
  const mediaType = params['MediaContentType0'] ?? ''

  const phone = normalisePhone(from)
  if (!phone) {
    await sendWhatsApp(from, 'Numéro non reconnu. / Unrecognised number.')
    return ok()
  }

  const cmd = body.toLowerCase().trim()

  // ── Cancel always works ───────────────────────────────────────────────────
  if (cmd === 'annuler' || cmd === 'cancel') {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(
      from,
      '❌ Inscription annulée. / Registration cancelled.\n\n' +
      'Envoyez "aide" pour recommencer. / Send "help" to start over.'
    )
    return ok()
  }

  // ── Check for active signup session ──────────────────────────────────────
  const { data: session } = await supabaseAdmin
    .from('signup_sessions')
    .select('*')
    .eq('phone', phone)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (session) {
    return handleSession(from, phone, body, cmd, session)
  }

  // ── Look up vendor (restaurant by whatsapp) ───────────────────────────────
  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, whatsapp, is_active, customer_id')
    .or(`whatsapp.eq.${phone},whatsapp.eq.${from}`)
    .maybeSingle()

  if (restaurant?.is_active) {
    return handleVendor(from, phone, body, cmd, numMedia, mediaUrl, mediaType, restaurant)
  }

  if (restaurant && !restaurant.is_active) {
    return handlePendingVendor(from, restaurant.name)
  }

  // ── Look up customer ──────────────────────────────────────────────────────
  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, name, city')
    .eq('phone', phone)
    .maybeSingle()

  if (customer) {
    return handleCustomer(from, phone, cmd, customer)
  }

  // ── Brand-new user → start customer signup ────────────────────────────────
  await supabaseAdmin.from('signup_sessions').upsert({
    phone,
    user_type:  'customer',
    step:       1,
    data:       {},
    expires_at: sessionExpiry(),
  })

  await sendWhatsApp(
    from,
    '👋 Bienvenue sur *Ndjoka & Tchop*!\n' +
    'Inscrivez-vous en 2 étapes. / Welcome! Sign up in 2 steps.\n\n' +
    'Quel est votre *nom*? / What is your *name*?\n\n' +
    '_Envoyez "annuler" pour annuler. / Send "cancel" to cancel._'
  )
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION HANDLER
// ─────────────────────────────────────────────────────────────────────────────
async function handleSession(
  from:    string,
  phone:   string,
  body:    string,
  cmd:     string,
  session: { user_type: string; step: number; data: Record<string, string> }
): Promise<NextResponse> {

  const { user_type, step, data } = session

  // ── Customer signup ──────────────────────────────────────────────────────
  if (user_type === 'customer') {

    if (step === 1) {
      // Waiting for name
      const name = body.trim()
      if (!name || name.length < 2) {
        await sendWhatsApp(from, 'Merci d\'entrer un prénom valide. / Please enter a valid name.')
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        step: 2, data: { ...data, name }, expires_at: sessionExpiry(),
      }).eq('phone', phone)

      await sendWhatsApp(
        from,
        `Bonjour *${name}*! 🎉\n\n` +
        'Dans quelle *ville* êtes-vous? / Which *city* are you in?\n\n' +
        '1️⃣ Yaoundé\n2️⃣ Abidjan\n3️⃣ Dakar\n4️⃣ Lomé\n\n' +
        '_Tapez le nom ou le chiffre. / Type the name or number._'
      )
      return ok()
    }

    if (step === 2) {
      // Waiting for city
      const city = parseCity(body)
      if (!city) {
        await sendWhatsApp(
          from,
          'Choisissez parmi / Choose from:\n1️⃣ Yaoundé  2️⃣ Abidjan  3️⃣ Dakar  4️⃣ Lomé'
        )
        return ok()
      }

      const name = data.name ?? 'Ami'

      // Create customer
      const { data: newCustomer, error } = await supabaseAdmin
        .from('customers')
        .insert({ phone, name, city })
        .select('id')
        .single()

      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)

      if (error || !newCustomer) {
        console.error('[whatsapp] customer insert error:', error?.message)
        await sendWhatsApp(from, '❌ Erreur lors de l\'inscription. Réessayez. / Error. Please retry.')
        return ok()
      }

      // Assign welcome voucher
      const { data: voucher } = await supabaseAdmin
        .from('vouchers').select('id').eq('code', 'BIENVENUE10').maybeSingle()
      if (voucher) {
        await supabaseAdmin.from('customer_vouchers')
          .insert({ customer_id: newCustomer.id, voucher_id: voucher.id })
      }

      await sendWhatsApp(
        from,
        `✅ *Bienvenue ${name}!* 🍽️\n\n` +
        `Votre compte est créé. / Your account is created.\n\n` +
        `🌍 Consultez les restaurants / Browse restaurants:\n${BASE_URL}\n\n` +
        `🔑 Connectez-vous ici / Log in here:\n${BASE_URL}/account\n\n` +
        `🏪 Vous avez un restaurant? Envoyez *restaurant* pour l'inscrire!\n` +
        `Own a restaurant? Send *restaurant* to register it!`
      )
      return ok()
    }
  }

  // ── Vendor signup ────────────────────────────────────────────────────────
  if (user_type === 'vendor') {

    if (step === 1) {
      const restaurantName = body.trim()
      if (!restaurantName || restaurantName.length < 2) {
        await sendWhatsApp(from, 'Merci d\'entrer un nom valide. / Please enter a valid name.')
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        step: 2, data: { ...data, restaurant_name: restaurantName }, expires_at: sessionExpiry(),
      }).eq('phone', phone)
      await sendWhatsApp(
        from,
        `*${restaurantName}* — super!\n\n` +
        'Dans quel *quartier* êtes-vous situé? / What *neighborhood* are you in?\n' +
        '_Ex: Bastos, Plateau, Cocody, Médina…_'
      )
      return ok()
    }

    if (step === 2) {
      const neighborhood = body.trim()
      if (!neighborhood || neighborhood.length < 2) {
        await sendWhatsApp(from, 'Merci d\'entrer un quartier valide. / Please enter a valid neighborhood.')
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        step: 3, data: { ...data, neighborhood }, expires_at: sessionExpiry(),
      }).eq('phone', phone)
      await sendWhatsApp(
        from,
        'Type de *cuisine*? / *Cuisine* type?\n\n' +
        '1️⃣ Camerounaise\n2️⃣ Sénégalaise\n3️⃣ Ivoirienne\n' +
        '4️⃣ Fast-food\n5️⃣ Grillades\n6️⃣ Autre\n\n' +
        '_Tapez le nom ou le chiffre. / Type name or number._'
      )
      return ok()
    }

    if (step === 3) {
      const cuisine = parseCuisine(body)
      if (!cuisine) {
        await sendWhatsApp(
          from,
          'Choisissez / Choose:\n1 Camerounaise  2 Sénégalaise  3 Ivoirienne\n4 Fast-food  5 Grillades  6 Autre'
        )
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        step: 4, data: { ...data, cuisine_type: cuisine }, expires_at: sessionExpiry(),
      }).eq('phone', phone)
      await sendWhatsApp(
        from,
        'Dans quelle *ville*? / Which *city*?\n\n' +
        '1️⃣ Yaoundé\n2️⃣ Abidjan\n3️⃣ Dakar\n4️⃣ Lomé'
      )
      return ok()
    }

    if (step === 4) {
      const city = parseCity(body)
      if (!city) {
        await sendWhatsApp(
          from,
          'Choisissez / Choose:\n1️⃣ Yaoundé  2️⃣ Abidjan  3️⃣ Dakar  4️⃣ Lomé'
        )
        return ok()
      }

      const restaurantName = data.restaurant_name ?? 'Restaurant'
      const neighborhood   = data.neighborhood   ?? ''
      const cuisine        = data.cuisine_type   ?? 'Autre'
      const customerId     = data.customer_id    ?? null

      const { data: newRestaurant, error } = await supabaseAdmin
        .from('restaurants')
        .insert({
          name:         restaurantName,
          neighborhood,
          cuisine_type: cuisine,
          city,
          whatsapp:     phone,
          customer_id:  customerId,
          is_active:    false,
          lat:          0,
          lng:          0,
        })
        .select('id')
        .single()

      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)

      if (error || !newRestaurant) {
        console.error('[whatsapp] restaurant insert error:', error?.message)
        await sendWhatsApp(from, '❌ Erreur lors de l\'inscription. Réessayez. / Error. Please retry.')
        return ok()
      }

      await sendWhatsApp(
        from,
        `✅ *${restaurantName}* est enregistré! 🎉\n` +
        `En attente d\'approbation (24h). / Pending approval (24h).\n\n` +
        `Votre page / Your page:\n${BASE_URL}/restaurant/${newRestaurant.id}\n\n` +
        `Envoyez *aide* pour les commandes disponibles.\n` +
        `Send *help* for available commands.`
      )
      return ok()
    }
  }

  // Unknown session state — reset
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
  numMedia:   number,
  mediaUrl:   string,
  mediaType:  string,
  restaurant: { id: string; name: string; whatsapp: string; is_active: boolean; customer_id: string | null }
): Promise<NextResponse> {

  // ── AIDE / HELP ─────────────────────────────────────────────────────────
  if (cmd === 'aide' || cmd === 'help' || cmd === '') {
    await sendWhatsApp(
      from,
      `🍽️ *Ndjoka & Tchop — ${restaurant.name}*\n\n` +
      'Commandes / Commands:\n\n' +
      '📋 *menu* — Voir vos plats / View your menu\n' +
      '🛒 *commandes* (ou *orders*) — Commandes en attente / Pending orders\n' +
      `🔗 *restaurant* — Voir votre page / View your page\n\n` +
      '➕ *Ajouter un plat:* Nom - Prix  (ex: Ndolé - 2500)\n' +
      '➕ *Add a dish:* Name - Price  (e.g. Ndolé - 2500)\n\n' +
      '📸 Joignez une photo pour l\'image du plat. / Attach a photo for the dish image.'
    )
    return ok()
  }

  // ── RESTAURANT PAGE ──────────────────────────────────────────────────────
  if (cmd === 'restaurant') {
    await sendWhatsApp(
      from,
      `🔗 *${restaurant.name}*\n${BASE_URL}/restaurant/${restaurant.id}`
    )
    return ok()
  }

  // ── MENU ─────────────────────────────────────────────────────────────────
  if (cmd === 'menu') {
    const { data: items } = await supabaseAdmin
      .from('menu_items')
      .select('name, price, is_available, category')
      .eq('restaurant_id', restaurant.id)
      .order('category').order('name')

    if (!items || items.length === 0) {
      await sendWhatsApp(
        from,
        'Votre menu est vide. / Your menu is empty.\n\nAjoutez un plat: Nom - Prix\nAdd a dish: Name - Price'
      )
      return ok()
    }

    const lines = items.map(i =>
      `${i.is_available ? '✅' : '❌'} ${i.name} — ${Number(i.price).toLocaleString()} FCFA`
    )
    await sendWhatsApp(
      from,
      `🍽️ *Menu — ${restaurant.name}*\n(${items.length} plat${items.length > 1 ? 's' : ''})\n\n` +
      lines.join('\n')
    )
    return ok()
  }

  // ── COMMANDES / ORDERS ───────────────────────────────────────────────────
  if (cmd === 'commandes' || cmd === 'orders') {
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, customer_name, customer_phone, items, total_price, status, created_at')
      .eq('restaurant_id', restaurant.id)
      .in('status', ['pending', 'confirmed', 'preparing'])
      .order('created_at', { ascending: false })
      .limit(10)

    if (!orders || orders.length === 0) {
      await sendWhatsApp(from, 'Aucune commande en attente. ✅\nNo pending orders. ✅')
      return ok()
    }

    const lines = orders.map(o => {
      const time        = new Date(o.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      const itemSummary = Array.isArray(o.items)
        ? o.items.map((i: { name: string; quantity: number }) => `${i.quantity}× ${i.name}`).join(', ')
        : ''
      return `[${time}] ${o.customer_name} — ${Number(o.total_price).toLocaleString()} FCFA\n  ${itemSummary}`
    })

    await sendWhatsApp(
      from,
      `🛒 *Commandes en cours — ${restaurant.name}*\n` +
      `(${orders.length} commande${orders.length > 1 ? 's' : ''})\n\n` +
      lines.join('\n\n')
    )
    return ok()
  }

  // ── ADD MENU ITEM: "Dish Name - Price" ───────────────────────────────────
  const menuItemMatch = body.match(/^(.+?)\s*[-\u2013\u2014]\s*([\d\s]+)\s*$/)
  if (menuItemMatch) {
    const dishName = menuItemMatch[1].trim()
    const price    = parseInt(menuItemMatch[2].replace(/\s/g, ''), 10)

    if (!dishName || isNaN(price) || price <= 0) {
      await sendWhatsApp(
        from,
        'Format invalide. / Invalid format.\nEx: Ndolé - 2500'
      )
      return ok()
    }

    let photoUrl: string | null = null
    if (numMedia > 0 && mediaType.startsWith('image/') && mediaUrl) {
      const media = await downloadTwilioMedia(mediaUrl)
      if (media) photoUrl = await uploadMenuImage(media.buffer, media.contentType)
    }

    const { error } = await supabaseAdmin.from('menu_items').insert({
      restaurant_id:    restaurant.id,
      name:             dishName,
      price,
      photo_url:        photoUrl,
      category:         'Plats principaux',
      is_available:     true,
      is_daily_special: false,
      description:      '',
    })

    if (error) {
      console.error('[whatsapp] menu insert error:', error.message)
      await sendWhatsApp(from, '❌ Erreur lors de l\'ajout. Réessayez. / Error adding dish. Retry.')
      return ok()
    }

    await sendWhatsApp(
      from,
      `✅ *${dishName}* ajouté au menu${photoUrl ? ' 📸' : ''}\n` +
      `Prix: ${price.toLocaleString()} FCFA\n\n` +
      'Envoyez "menu" pour voir vos plats. / Send "menu" to see your dishes.'
    )
    return ok()
  }

  // ── Unknown ──────────────────────────────────────────────────────────────
  await sendWhatsApp(
    from,
    'Je n\'ai pas compris. Envoyez "aide" pour la liste des commandes.\n' +
    'I didn\'t understand. Send "help" for the list of commands.'
  )
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING VENDOR
// ─────────────────────────────────────────────────────────────────────────────
async function handlePendingVendor(from: string, restaurantName: string): Promise<NextResponse> {
  await sendWhatsApp(
    from,
    `⏳ *${restaurantName}* est en attente de validation.\n` +
    'Your restaurant is pending approval.\n\n' +
    'Notre équipe vous contactera sous 24h. / Our team will contact you within 24h.'
  )
  return ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTERED CUSTOMER (no active restaurant)
// ─────────────────────────────────────────────────────────────────────────────
async function handleCustomer(
  from:     string,
  phone:    string,
  cmd:      string,
  customer: { id: string; name: string; city: string }
): Promise<NextResponse> {

  // ── AIDE / HELP ──────────────────────────────────────────────────────────
  if (cmd === 'aide' || cmd === 'help' || cmd === '') {
    await sendWhatsApp(
      from,
      `👋 *Bonjour ${customer.name}!* / *Hello ${customer.name}!*\n\n` +
      `🌍 Parcourez les restaurants / Browse restaurants:\n${BASE_URL}\n\n` +
      `🔑 Votre compte / Your account:\n${BASE_URL}/account\n\n` +
      `🏪 Envoyez *restaurant* pour inscrire votre restaurant!\n` +
      `Send *restaurant* to register your restaurant!`
    )
    return ok()
  }

  // ── START VENDOR SIGNUP ──────────────────────────────────────────────────
  if (cmd === 'restaurant' || cmd === 'inscription' || cmd === 'register') {
    await supabaseAdmin.from('signup_sessions').upsert({
      phone,
      user_type:  'vendor',
      step:       1,
      data:       { customer_id: customer.id },
      expires_at: sessionExpiry(),
    })
    await sendWhatsApp(
      from,
      `🏪 *Inscription restaurant / Restaurant registration*\n\n` +
      'Quel est le *nom* de votre restaurant?\n' +
      'What is your *restaurant name*?\n\n' +
      '_Envoyez "annuler" pour annuler. / Send "cancel" to cancel._'
    )
    return ok()
  }

  // ── Unknown ──────────────────────────────────────────────────────────────
  await sendWhatsApp(
    from,
    `Envoyez *aide* pour les options disponibles.\nSend *help* for available options.`
  )
  return ok()
}
