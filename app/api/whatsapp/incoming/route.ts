import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp } from '@/lib/whatsapp'

// ── Empty TwiML ack (replies are sent via REST API to avoid XML-escaping issues) ──

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
const TWIML_HEADERS = { 'Content-Type': 'text/xml' }

function ok(): NextResponse {
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS })
}

// ── Normalise phone number ────────────────────────────────────────────────────

function normalisePhone(raw: string): string {
  return raw.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '')
}

// ── Download Twilio media with Basic auth ─────────────────────────────────────

async function downloadTwilioMedia(mediaUrl: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const apiKeySid    = process.env.TWILIO_API_KEY_SID!
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET!
    const res = await fetch(mediaUrl, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`,
      },
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, contentType }
  } catch {
    return null
  }
}

// ── Upload image to Supabase Storage ─────────────────────────────────────────

async function uploadMenuImage(buffer: Buffer, contentType: string): Promise<string | null> {
  const ext = contentType.split('/')[1]?.split(';')[0] ?? 'jpg'
  const path = `menu-images/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  const { error } = await supabaseAdmin.storage
    .from('menu-images')
    .upload(path, buffer, { contentType, upsert: false })

  if (error) {
    console.error('[whatsapp] storage upload error:', error.message)
    return null
  }

  const { data } = supabaseAdmin.storage.from('menu-images').getPublicUrl(path)
  return data.publicUrl
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const params  = Object.fromEntries(new URLSearchParams(rawBody))

  const from      = params['From'] ?? ''          // 'whatsapp:+237XXXXXXXXX'
  const body      = (params['Body'] ?? '').trim()
  const numMedia  = parseInt(params['NumMedia'] ?? '0', 10)
  const mediaUrl  = params['MediaUrl0'] ?? ''
  const mediaType = params['MediaContentType0'] ?? ''

  const phone = normalisePhone(from)

  if (!phone) {
    await sendWhatsApp(from, 'Numéro non reconnu. / Unrecognised number.')
    return ok()
  }

  // ── Look up vendor ──────────────────────────────────────────────────────────
  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, whatsapp, is_active')
    .or(`whatsapp.eq.${phone},whatsapp.eq.${from}`)
    .maybeSingle()

  // Unregistered vendor
  if (!restaurant) {
    await sendWhatsApp(
      from,
      '👋 Bienvenue sur Ndjoka & Tchop !\n' +
      'Votre numéro n\'est pas encore enregistré.\n' +
      'Inscrivez votre restaurant ici / Register your restaurant here:\n' +
      'https://streetmenu.vercel.app/join'
    )
    return ok()
  }

  // Pending approval (exists but not active)
  if (!restaurant.is_active) {
    await sendWhatsApp(
      from,
      '⏳ Votre restaurant est en attente de validation.\n' +
      'Your restaurant is pending approval.\n' +
      'Notre équipe vous contactera sous 24h. / Our team will contact you within 24h.'
    )
    return ok()
  }

  const cmd = body.toLowerCase().trim()

  // ── AIDE / HELP ─────────────────────────────────────────────────────────────
  if (cmd === 'aide' || cmd === 'help' || cmd === '') {
    await sendWhatsApp(
      from,
      `🍽️ *Ndjoka & Tchop — ${restaurant.name}*\n\n` +
      'Commandes disponibles / Available commands:\n\n' +
      '📋 *menu* — Voir vos plats / View your menu items\n' +
      '🛒 *commandes* (ou *orders*) — Voir les commandes en attente / View pending orders\n\n' +
      '➕ *Ajouter un plat / Add a dish:*\n' +
      'Envoyez: Nom du plat - Prix\n' +
      'Send: Dish Name - Price\n' +
      'Exemple / Example: Ndolé - 2500\n\n' +
      '📸 Joignez une photo pour ajouter l\'image du plat.\n' +
      'Attach a photo to add the dish image.'
    )
    return ok()
  }

  // ── MENU ────────────────────────────────────────────────────────────────────
  if (cmd === 'menu') {
    const { data: items } = await supabaseAdmin
      .from('menu_items')
      .select('name, price, is_available, category')
      .eq('restaurant_id', restaurant.id)
      .order('category')
      .order('name')

    if (!items || items.length === 0) {
      await sendWhatsApp(
        from,
        'Votre menu est vide. / Your menu is empty.\n\n' +
        'Ajoutez un plat en envoyant: Nom - Prix\n' +
        'Add a dish by sending: Name - Price'
      )
      return ok()
    }

    const lines = items.map(i =>
      `${i.is_available ? '✅' : '❌'} ${i.name} — ${Number(i.price).toLocaleString()} FCFA`
    )
    await sendWhatsApp(
      from,
      `🍽️ *Menu — ${restaurant.name}*\n` +
      `(${items.length} plat${items.length > 1 ? 's' : ''})\n\n` +
      lines.join('\n')
    )
    return ok()
  }

  // ── COMMANDES / ORDERS ──────────────────────────────────────────────────────
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
      const time = new Date(o.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      const itemSummary = Array.isArray(o.items)
        ? o.items.map((i: { name: string; quantity: number }) => `${i.quantity}× ${i.name}`).join(', ')
        : ''
      return `[${time}] ${o.customer_name} — ${Number(o.total_price).toLocaleString()} FCFA\n  ${itemSummary}`
    })

    await sendWhatsApp(
      from,
      `🛒 *Commandes en cours / Active orders — ${restaurant.name}*\n` +
      `(${orders.length} commande${orders.length > 1 ? 's' : ''})\n\n` +
      lines.join('\n\n')
    )
    return ok()
  }

  // ── MENU ITEM: "Dish Name - Price" ──────────────────────────────────────────
  // Match "anything - number" (price can be 500, 1500, 2 500, etc.)
  const menuItemMatch = body.match(/^(.+?)\s*[-\u2013\u2014]\s*([\d\s]+)\s*$/)
  if (menuItemMatch) {
    const dishName  = menuItemMatch[1].trim()
    const priceStr  = menuItemMatch[2].replace(/\s/g, '')
    const price     = parseInt(priceStr, 10)

    if (!dishName || isNaN(price) || price <= 0) {
      await sendWhatsApp(
        from,
        'Format invalide. Envoyez: Nom du plat - Prix (ex: Ndolé - 2500)\n' +
        'Invalid format. Send: Dish Name - Price (e.g. Ndolé - 2500)'
      )
      return ok()
    }

    // Handle optional photo
    let photoUrl: string | null = null
    if (numMedia > 0 && mediaType.startsWith('image/') && mediaUrl) {
      const media = await downloadTwilioMedia(mediaUrl)
      if (media) {
        photoUrl = await uploadMenuImage(media.buffer, media.contentType)
      }
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
      await sendWhatsApp(
        from,
        '❌ Erreur lors de l\'ajout. Réessayez. / Error adding dish. Please retry.'
      )
      return ok()
    }

    const photoConfirm = photoUrl ? ' 📸' : ''
    await sendWhatsApp(
      from,
      `✅ *${dishName}* ajouté au menu${photoConfirm}\n` +
      `Prix / Price: ${price.toLocaleString()} FCFA\n\n` +
      'Envoyez "menu" pour voir tous vos plats.\n' +
      'Send "menu" to see all your dishes.'
    )
    return ok()
  }

  // ── Unknown message ─────────────────────────────────────────────────────────
  await sendWhatsApp(
    from,
    'Je n\'ai pas compris. Envoyez "aide" pour la liste des commandes.\n' +
    'I didn\'t understand that. Send "help" for the list of commands.'
  )
  return ok()
}
