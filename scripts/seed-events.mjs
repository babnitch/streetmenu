// Seed script — 7 sample events (1 per category) in Yaoundé
// Run: node scripts/seed-events.mjs

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://xylfxtdgpptvieobvlfj.supabase.co'
const SUPABASE_KEY = 'sb_publishable_BeQNT7anFNpd29SqnseHPQ_E_IHwK-x'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const EVENTS = [
  {
    title: 'Afro Jazz Night — Yaoundé',
    description: 'Une soirée inoubliable avec les meilleurs artistes de jazz afro de la capitale. Ambiance feutrée, cocktails et musique live.',
    date: '2026-05-10',
    time: '20:00',
    venue: 'Institut Français du Cameroun',
    city: 'Yaoundé',
    neighborhood: 'Bastos',
    category: 'Music',
    price: 5000,
    cover_photo: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&auto=format&fit=crop',
    whatsapp: '+237677100100',
    organizer_name: 'Association Mboa Musique',
    is_active: true,
  },
  {
    title: 'Street Food Festival — Mvog-Ada',
    description: 'Plus de 30 restaurateurs de Yaoundé réunis pour un festival de street food. Ndolé, poulet DG, brochettes, beignets et bien plus.',
    date: '2026-05-17',
    time: '12:00',
    venue: 'Carrefour Warda',
    city: 'Yaoundé',
    neighborhood: 'Mvog-Ada',
    category: 'Food',
    price: 0,
    cover_photo: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800&auto=format&fit=crop',
    whatsapp: '+237690200200',
    organizer_name: 'StreetFood Cameroun',
    is_active: true,
  },
  {
    title: 'Tournoi Inter-Quartiers de Football',
    description: 'Grand tournoi de football opposant les 8 quartiers de Yaoundé. Finales en direct, animation et prix pour les équipes gagnantes.',
    date: '2026-05-24',
    time: '09:00',
    venue: 'Stade Omnisports de Yaoundé',
    city: 'Yaoundé',
    neighborhood: 'Mfandena',
    category: 'Sport',
    price: 1000,
    cover_photo: 'https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?w=800&auto=format&fit=crop',
    whatsapp: '+237655300300',
    organizer_name: 'Ligue Urbaine de Football',
    is_active: true,
  },
  {
    title: 'Exposition — "Mboa en Couleurs"',
    description: 'Exposition de peintures et photographies d\'artistes camerounais contemporains. Entrée libre. Rencontre avec les artistes le soir.',
    date: '2026-06-01',
    time: '10:00',
    venue: 'Musée National du Cameroun',
    city: 'Yaoundé',
    neighborhood: 'Centre-ville',
    category: 'Art',
    price: 0,
    cover_photo: 'https://images.unsplash.com/photo-1531058020387-3be344556be6?w=800&auto=format&fit=crop',
    whatsapp: '+237699400400',
    organizer_name: 'Collectif Arts Mboa',
    is_active: true,
  },
  {
    title: 'Nuit Électronique — Bastos',
    description: 'La meilleure soirée électronique de Yaoundé. DJs internationaux, son immersif, terrasse panoramique. Dress code chic.',
    date: '2026-05-30',
    time: '22:00',
    venue: 'Sky Lounge Bastos',
    city: 'Yaoundé',
    neighborhood: 'Bastos',
    category: 'Nightlife',
    price: 10000,
    cover_photo: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&auto=format&fit=crop',
    whatsapp: '+237677500500',
    organizer_name: 'Nocturne Events',
    is_active: true,
  },
  {
    title: 'Forum des Entrepreneurs — Yaoundé 2026',
    description: 'Conférences, ateliers pratiques et networking pour les entrepreneurs et startups d\'Afrique centrale. Intervenants de 12 pays.',
    date: '2026-06-05',
    time: '08:30',
    venue: 'Palais des Congrès de Yaoundé',
    city: 'Yaoundé',
    neighborhood: 'Centre-ville',
    category: 'Business',
    price: 15000,
    cover_photo: 'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?w=800&auto=format&fit=crop',
    whatsapp: '+237690600600',
    organizer_name: 'Africa Business Hub',
    is_active: true,
  },
  {
    title: 'BT Night — Club Étoudi',
    description: 'La soirée BT incontournable de Yaoundé. Ambiance garantie, bottles service, DJ resident et invités surprises toute la nuit.',
    date: '2026-05-22',
    time: '23:00',
    venue: 'Club Étoudi Palace',
    city: 'Yaoundé',
    neighborhood: 'Étoudi',
    category: 'BT / Club',
    price: 3000,
    cover_photo: 'https://images.unsplash.com/photo-1566737236500-c8ac43014a67?w=800&auto=format&fit=crop',
    whatsapp: '+237655700700',
    organizer_name: 'Étoudi Events',
    is_active: true,
  },
]

async function main() {
  console.log('\n🎉  Seeding 7 Yaoundé events into Supabase…\n')

  const { data, error } = await supabase
    .from('events')
    .insert(EVENTS)
    .select('id, title, category, date, is_active')

  if (error) {
    console.error('❌  Insert failed:', error.message)
    console.error('   Code:', error.code)
    process.exit(1)
  }

  console.log(`✅  Inserted ${data.length} / ${EVENTS.length} events:\n`)
  data.forEach((e, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. [${e.category.padEnd(12)}] ${e.title} (${e.date})`)
  })
  console.log('\n🎉  Done! Visit /events to see them live.\n')
}

main()
