import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp } from '@/lib/whatsapp'

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

const BASE_URL = 'https://streetmenu.vercel.app'

// ── Media helpers ─────────────────────────────────────────────────────────────
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
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType }
  } catch { return null }
}

async function uploadToStorage(bucket: string, buffer: Buffer, contentType: string): Promise<string | null> {
  const ext  = contentType.split('/')[1]?.split(';')[0] ?? 'jpg'
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const { error } = await supabaseAdmin.storage
    .from(bucket).upload(path, buffer, { contentType, upsert: false })
  if (error) { console.error(`[whatsapp] ${bucket} upload error:`, error.message); return null }
  const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(path)
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

  // Check for active session (onboarding or photo-update state)
  const { data: session } = await supabaseAdmin
    .from('signup_sessions').select('*')
    .eq('phone', phone).gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (session) {
    return handleSession(from, phone, body, cmd, session, hasPhoto, mediaUrl, mediaType)
  }

  // Look up vendor (active or pending)
  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, whatsapp, is_active, customer_id')
    .or(`whatsapp.eq.${phone},whatsapp.eq.${from}`)
    .maybeSingle()

  if (restaurant?.is_active) {
    return handleVendor(from, phone, body, cmd, hasPhoto, mediaUrl, restaurant)
  }
  if (restaurant && !restaurant.is_active) {
    return handlePendingVendor(from, restaurant.name)
  }

  // Look up registered customer
  const { data: customer } = await supabaseAdmin
    .from('customers').select('id, name, city')
    .eq('phone', phone).maybeSingle()

  if (customer) {
    return handleCustomer(from, phone, cmd, customer)
  }

  // Brand-new user → start customer signup
  await supabaseAdmin.from('signup_sessions').upsert({
    phone, user_type: 'customer', step: 1, data: {}, expires_at: sessionExpiry(),
  })
  await sendWhatsApp(from,
    '👋 Bienvenue sur *Ndjoka & Tchop*!\n' +
    'Inscrivez-vous en 2 étapes. / Welcome! Sign up in 2 steps.\n\n' +
    'Quel est votre *nom*? / What is your *name*?\n\n' +
    '_Envoyez "annuler" pour annuler. / Send "cancel" to cancel._')
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
  mediaType: string,
): Promise<NextResponse> {
  const { user_type, step, data } = session

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
      const { data: voucher } = await supabaseAdmin
        .from('vouchers').select('id').eq('code', 'BIENVENUE10').maybeSingle()
      if (voucher) {
        await supabaseAdmin.from('customer_vouchers')
          .insert({ customer_id: newCustomer.id, voucher_id: voucher.id })
      }
      await sendWhatsApp(from,
        `✅ *Bienvenue ${name}!* 🍽️\n\n` +
        `Votre compte est créé. / Your account is created.\n\n` +
        `🌍 Restaurants: ${BASE_URL}\n` +
        `🔑 Mon compte / My account: ${BASE_URL}/account\n\n` +
        `🏪 Vous avez un restaurant? Envoyez *restaurant*!\n` +
        `Own a restaurant? Send *restaurant*!`)
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
        const media = await downloadTwilioMedia(mediaUrl)
        if (media) imageUrl = await uploadToStorage('restaurant-images', media.buffer, media.contentType)
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
  restaurant: { id: string; name: string; whatsapp: string; is_active: boolean; customer_id: string | null },
): Promise<NextResponse> {

  // ── AIDE / HELP ──────────────────────────────────────────────────────────
  if (cmd === 'aide' || cmd === 'help' || cmd === '') {
    await sendWhatsApp(from,
      `🍽️ *Ndjoka & Tchop — ${restaurant.name}*\n\n` +
      `📋 *Commandes disponibles / Available commands:*\n\n` +
      `📸 Photo + "Nom - Prix" → Ajouter un plat / Add a dish\n` +
      `💰 "prix [nom] [prix]" → Changer le prix / Update price\n` +
      `✅ "dispo [nom]" → Marquer disponible / Mark available\n` +
      `❌ "indispo [nom]" → Marquer indisponible / Mark unavailable\n` +
      `🗑️ "supprimer [nom]" → Supprimer un plat / Delete a dish\n` +
      `📷 "photo restaurant" → Changer la photo du restaurant / Update restaurant photo\n` +
      `🍽️ "menu" → Voir votre menu / View your menu\n` +
      `📦 "commandes" → Voir les commandes / View orders\n` +
      `🔗 "restaurant" → Voir votre page / View your page\n` +
      `❓ "aide" → Ce message / This message`)
    return ok()
  }

  // ── RESTAURANT PAGE ──────────────────────────────────────────────────────
  if (cmd === 'restaurant') {
    await sendWhatsApp(from, `🔗 *${restaurant.name}*\n${BASE_URL}/restaurant/${restaurant.id}`)
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
  if (hasPhoto) {
    const caption = body.trim()

    // Caption matches "Name - Price" → add new item with photo
    const newItemMatch = caption.match(/^(.+?)\s*[-\u2013\u2014]\s*([\d\s]+)\s*$/)
    if (newItemMatch) {
      const dishName = newItemMatch[1].trim()
      const price    = parseInt(newItemMatch[2].replace(/\s/g, ''), 10)
      if (!dishName || isNaN(price) || price <= 0) {
        await sendWhatsApp(from, 'Format invalide. Ex: Ndolé - 2500')
        return ok()
      }
      const media    = await downloadTwilioMedia(mediaUrl)
      const photoUrl = media ? await uploadToStorage('menu-images', media.buffer, media.contentType) : null
      const { error } = await supabaseAdmin.from('menu_items').insert({
        restaurant_id: restaurant.id, name: dishName, price,
        photo_url: photoUrl, category: 'Plats principaux',
        is_available: true, is_daily_special: false, description: '',
      })
      if (error) {
        console.error('[whatsapp] menu insert error:', error.message)
        await sendWhatsApp(from, '❌ Erreur. Réessayez. / Error. Retry.')
        return ok()
      }
      await sendWhatsApp(from,
        `✅ *${dishName}* ajouté${photoUrl ? ' 📸' : ''}\n` +
        `Prix: ${price.toLocaleString()} FCFA`)
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

  // ── ADD ITEM (text only, no photo): "Ndolé - 2500" ──────────────────────
  const textItemMatch = body.match(/^(.+?)\s*[-\u2013\u2014]\s*([\d\s]+)\s*$/)
  if (textItemMatch) {
    const dishName = textItemMatch[1].trim()
    const price    = parseInt(textItemMatch[2].replace(/\s/g, ''), 10)
    if (!dishName || isNaN(price) || price <= 0) {
      await sendWhatsApp(from, 'Format invalide. Ex: Ndolé - 2500')
      return ok()
    }
    // Make sure it's not accidentally matched by price/dispo/etc. patterns above
    const { error } = await supabaseAdmin.from('menu_items').insert({
      restaurant_id: restaurant.id, name: dishName, price,
      photo_url: null, category: 'Plats principaux',
      is_available: true, is_daily_special: false, description: '',
    })
    if (error) {
      console.error('[whatsapp] menu insert error:', error.message)
      await sendWhatsApp(from, '❌ Erreur. Réessayez. / Error. Retry.')
      return ok()
    }
    await sendWhatsApp(from,
      `✅ *${dishName}* ajouté au menu\nPrix: ${price.toLocaleString()} FCFA\n\n` +
      '📸 Envoyez une photo avec la même légende pour ajouter une image.\n' +
      '📸 Send a photo with the same caption to add an image.')
    return ok()
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
  customer: { id: string; name: string; city: string },
): Promise<NextResponse> {
  if (cmd === 'aide' || cmd === 'help' || cmd === '') {
    await sendWhatsApp(from,
      `👋 *Bonjour ${customer.name}!* / *Hello ${customer.name}!*\n\n` +
      `🌍 Parcourez les restaurants / Browse:\n${BASE_URL}\n\n` +
      `🔑 Votre compte / Your account:\n${BASE_URL}/account\n\n` +
      `🏪 Envoyez *restaurant* pour inscrire votre restaurant!\n` +
      `Send *restaurant* to register your restaurant!`)
    return ok()
  }

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
