// Seed menu items for 10 Yaoundé restaurants
// Run: node scripts/seed-menu-items.mjs

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://xylfxtdgpptvieobvlfj.supabase.co'
const SUPABASE_KEY = 'sb_publishable_BeQNT7anFNpd29SqnseHPQ_E_IHwK-x'
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Menu definitions keyed by restaurant name ──────────────────────────────
const MENUS = {
  'Chez Mama Biya': [
    { name: 'Poulet DG', description: 'Poulet sauté aux légumes et plantains, spécialité de la maison', price: 3500, category: 'Plats principaux', is_daily_special: true },
    { name: 'Ndolé au poisson fumé', description: 'Feuilles de ndolé mijotées avec poisson fumé et arachides pilées', price: 2500, category: 'Plats principaux', is_daily_special: false },
    { name: 'Riz sauté aux légumes', description: 'Riz sauté maison avec légumes de saison', price: 1500, category: 'Plats principaux', is_daily_special: false },
    { name: 'Plantain braisé', description: 'Plantains mûrs grillés à la braise', price: 600, category: 'Entrées', is_daily_special: false },
    { name: 'Bâtons de manioc', description: 'Bâtons de manioc frais, faits maison', price: 500, category: 'Entrées', is_daily_special: false },
    { name: 'Bissap glacé', description: 'Jus d\'hibiscus frais, légèrement sucré', price: 500, category: 'Boissons', is_daily_special: false },
    { name: 'Eau minérale', description: 'Eau minérale 1,5 L', price: 300, category: 'Boissons', is_daily_special: false },
  ],

  'Le Braiseur du Centre': [
    { name: 'Poulet braisé demi', description: 'Demi poulet braisé à la braise, servi avec plantains et sauce piment', price: 3000, category: 'Grillades', is_daily_special: true },
    { name: 'Brochettes bœuf ×5', description: 'Cinq brochettes de bœuf marinées et grillées', price: 2000, category: 'Grillades', is_daily_special: false },
    { name: 'Poisson braisé tilapia', description: 'Tilapia entier braisé, sauce tomate et oignons', price: 3500, category: 'Grillades', is_daily_special: false },
    { name: 'Côtelettes de porc', description: 'Côtelettes de porc marinées aux épices locales, grillées au feu de bois', price: 2500, category: 'Grillades', is_daily_special: true },
    { name: 'Plantain braisé', description: 'Plantains dorés à la braise', price: 700, category: 'Entrées', is_daily_special: false },
    { name: 'Salade de crudités', description: 'Salade fraîche tomate, concombre et oignons', price: 500, category: 'Entrées', is_daily_special: false },
    { name: 'Bière 33 Export', description: 'Bière 33 cl bien fraîche', price: 700, category: 'Boissons', is_daily_special: false },
    { name: 'Jus de gingembre', description: 'Gingembre frais pressé maison', price: 500, category: 'Boissons', is_daily_special: false },
  ],

  'Maquis Mvog-Ada': [
    { name: 'Soya bœuf', description: 'Petites brochettes de bœuf épicées, spécialité de rue', price: 1500, category: 'Grillades', is_daily_special: true },
    { name: 'Attiéké poisson frit', description: 'Semoule de manioc avec poisson frit et sauce tomate', price: 2000, category: 'Plats principaux', is_daily_special: false },
    { name: 'Omelette piment', description: 'Omelette aux oignons, tomates et piment vert', price: 1000, category: 'Plats principaux', is_daily_special: false },
    { name: 'Beignets haricots', description: 'Beignets de haricots frits, croustillants', price: 500, category: 'Entrées', is_daily_special: false },
    { name: 'Miondo (bâton de manioc)', description: 'Bâtons de manioc fermenté, accompagnement traditionnel', price: 300, category: 'Entrées', is_daily_special: false },
    { name: 'Jus de gingembre maison', description: 'Gingembre et citron pressés frais', price: 500, category: 'Boissons', is_daily_special: false },
    { name: 'Top Ananas', description: 'Soda ananas bien frais', price: 400, category: 'Boissons', is_daily_special: false },
  ],

  'Restaurant Fouda & Fils': [
    { name: 'Ndolé crevettes', description: 'Ndolé aux crevettes fraîches et arachides, recette ancestrale Bassa', price: 3000, category: 'Plats principaux', is_daily_special: true },
    { name: 'Eru complet', description: 'Eru aux feuilles de waterleaf, coco râpé, crevettes fumées et huile de palme', price: 3500, category: 'Plats principaux', is_daily_special: false },
    { name: 'Achu jaune', description: 'Taro pilé servi avec sauce jaune aux épices des Grassfields', price: 2500, category: 'Plats principaux', is_daily_special: false },
    { name: 'Mbongo tchobi', description: 'Poisson en sauce noire aux épices du Moungo — plat de cérémonie', price: 4000, category: 'Plats principaux', is_daily_special: true },
    { name: 'Koki maïs', description: 'Gâteau de maïs cuit à la vapeur dans les feuilles de bananier', price: 1000, category: 'Entrées', is_daily_special: false },
    { name: 'Plantain jaune bouilli', description: 'Plantains mûrs bouillis, accompagnement classique', price: 600, category: 'Entrées', is_daily_special: false },
    { name: 'Folérés glacé', description: 'Infusion de fleurs d\'hibiscus séchées, sucrée et glacée', price: 500, category: 'Boissons', is_daily_special: false },
  ],

  'Chez Tantine Adjoua': [
    { name: 'Sanga', description: 'Maïs et haricots mijotés à l\'huile de palme avec des feuilles de taro', price: 2500, category: 'Plats principaux', is_daily_special: true },
    { name: 'Poulet yassa', description: 'Poulet mariné aux citrons et oignons, sauce yassa onctueuse', price: 3000, category: 'Plats principaux', is_daily_special: false },
    { name: 'Haricots rouges & plantain', description: 'Haricots rouges en sauce, servis avec plantains dorés', price: 1500, category: 'Plats principaux', is_daily_special: false },
    { name: 'Poisson fumé en sauce', description: 'Poisson fumé mijoté en sauce tomate et piment', price: 2000, category: 'Plats principaux', is_daily_special: false },
    { name: 'Beignets plantain', description: 'Beignets de plantain mûr sucrés', price: 500, category: 'Entrées', is_daily_special: false },
    { name: 'Lipton chaud', description: 'Thé Lipton au lait concentré', price: 300, category: 'Boissons', is_daily_special: false },
    { name: 'Jus de baobab', description: 'Jus de pain de singe épais et rafraîchissant', price: 600, category: 'Boissons', is_daily_special: false },
  ],

  'Grillade Etoudi Palace': [
    { name: 'Demi poulet braisé', description: 'Demi poulet braisé à la perfection, sauce piment maison', price: 3000, category: 'Grillades', is_daily_special: true },
    { name: 'Quart poulet braisé', description: 'Quart de poulet, idéal pour un repas rapide', price: 1500, category: 'Grillades', is_daily_special: false },
    { name: 'Brochettes poulet ×5', description: 'Cinq brochettes de poulet marinées aux épices', price: 2000, category: 'Grillades', is_daily_special: false },
    { name: 'Brochettes porc ×5', description: 'Brochettes de porc bien épicées', price: 2000, category: 'Grillades', is_daily_special: false },
    { name: 'Frites maison', description: 'Frites de pommes de terre fraîches', price: 700, category: 'Entrées', is_daily_special: false },
    { name: 'Salade coleslaw', description: 'Chou blanc, carottes et mayonnaise maison', price: 500, category: 'Entrées', is_daily_special: false },
    { name: 'Coca-Cola', description: 'Coca-Cola 33 cl bien frais', price: 500, category: 'Boissons', is_daily_special: false },
  ],

  'Le Bord du Lac — Melen': [
    { name: 'Tilapia braisé entier', description: 'Tilapia du lac braisé à la braise de bois, sauce tomate fraîche', price: 4500, category: 'Grillades', is_daily_special: true },
    { name: 'Silure braisé', description: 'Silure (poisson-chat) braisé, chair ferme et savoureuse', price: 5000, category: 'Grillades', is_daily_special: false },
    { name: 'Crevettes sautées à l\'ail', description: 'Crevettes fraîches sautées à l\'ail et au beurre', price: 3500, category: 'Plats principaux', is_daily_special: true },
    { name: 'Capitaine braisé', description: 'Poisson capitaine grillé, accompagnement au choix', price: 4000, category: 'Grillades', is_daily_special: false },
    { name: 'Attiéké maison', description: 'Semoule de manioc fermentée, légèrement acidulée', price: 600, category: 'Entrées', is_daily_special: false },
    { name: 'Riz blanc', description: 'Riz blanc cuit à la vapeur', price: 500, category: 'Entrées', is_daily_special: false },
    { name: 'Bière Mutzig', description: 'Mutzig pression 50 cl, brassée au Cameroun', price: 800, category: 'Boissons', is_daily_special: false },
    { name: 'Jus de fruit frais', description: 'Jus pressé du jour : mangue, ananas ou papaye', price: 700, category: 'Boissons', is_daily_special: false },
  ],

  'Snack Biyem-Assi Express': [
    { name: 'Sandwich poulet frites', description: 'Baguette croustillante, escalope de poulet panée et frites maison', price: 1500, category: 'Plats principaux', is_daily_special: true },
    { name: 'Omelette baguette', description: 'Baguette garnie d\'omelette aux oignons et tomates', price: 1000, category: 'Plats principaux', is_daily_special: false },
    { name: 'Spaghettis sautés', description: 'Spaghettis sautés aux légumes et thon, recette express', price: 1200, category: 'Plats principaux', is_daily_special: false },
    { name: 'Riz sauté soja', description: 'Riz sauté avec sauce soja et légumes', price: 1000, category: 'Plats principaux', is_daily_special: false },
    { name: 'Beignets haricots', description: 'Beignets de haricots croustillants, piment en option', price: 500, category: 'Entrées', is_daily_special: false },
    { name: 'Jus de gingembre maison', description: 'Gingembre frais pressé, citron et miel', price: 400, category: 'Boissons', is_daily_special: false },
    { name: 'Eau minérale', description: 'Eau minérale plate 1,5 L', price: 300, category: 'Boissons', is_daily_special: false },
  ],

  'Al-Wadi Libanais': [
    { name: 'Chawarma poulet', description: 'Poulet mariné aux épices du Levant, pain pita, sauce ail et légumes frais', price: 2500, category: 'Plats principaux', is_daily_special: true },
    { name: 'Falafel assiette', description: 'Six falafels croustillants, houmous, salade et pain pita', price: 2000, category: 'Plats principaux', is_daily_special: false },
    { name: 'Houmous & pain pita', description: 'Purée de pois chiche à l\'huile d\'olive et za\'atar', price: 1500, category: 'Entrées', is_daily_special: false },
    { name: 'Taboulé libanais', description: 'Persil frais, boulgour, tomates, citron et huile d\'olive', price: 1200, category: 'Entrées', is_daily_special: false },
    { name: 'Fattoush', description: 'Salade libanaise aux légumes frais et pain croustillant', price: 1000, category: 'Entrées', is_daily_special: false },
    { name: 'Knafeh', description: 'Gâteau de semoule au fromage et sirop de fleur d\'oranger', price: 1500, category: 'Desserts', is_daily_special: false },
    { name: 'Thé à la menthe', description: 'Thé vert à la menthe fraîche, sucré à souhait', price: 500, category: 'Boissons', is_daily_special: false },
    { name: 'Jus d\'orange pressé', description: 'Oranges pressées du moment', price: 800, category: 'Boissons', is_daily_special: false },
  ],

  'La Terrasse de Briqueterie': [
    { name: 'Ndolé aux arachides', description: 'Ndolé version Bamiléké, riche en arachides pilées et crevettes séchées', price: 2500, category: 'Plats principaux', is_daily_special: true },
    { name: 'Okok (feuilles de manioc)', description: 'Feuilles de manioc pilées, huile de palme et poisson fumé', price: 3000, category: 'Plats principaux', is_daily_special: false },
    { name: 'Bâton de manioc & poisson', description: 'Miondo avec poisson braisé, accompagnement traditionnel Bassa', price: 2000, category: 'Plats principaux', is_daily_special: false },
    { name: 'Kpem (feuilles de taro)', description: 'Feuilles de taro mijotées à l\'huile rouge, poisson fumé', price: 2500, category: 'Plats principaux', is_daily_special: true },
    { name: 'Plantain mûr frit', description: 'Rondelles de plantain mûr frites, dorées et caramélisées', price: 600, category: 'Entrées', is_daily_special: false },
    { name: 'Eau de coco fraîche', description: 'Coco fraîche directement de la noix', price: 500, category: 'Boissons', is_daily_special: false },
    { name: 'Folérés glacé', description: 'Bissap rouge et fleurs séchées, servi glacé', price: 600, category: 'Boissons', is_daily_special: false },
  ],
}

async function main() {
  console.log('\n🍽️  Fetching Yaoundé restaurant IDs…\n')

  const { data: restaurants, error: rErr } = await sb
    .from('restaurants')
    .select('id, name')
    .eq('city', 'Yaoundé')

  if (rErr) { console.error('❌ Could not fetch restaurants:', rErr.message); process.exit(1) }

  // Build name → id map (trim whitespace for safety)
  const idMap = Object.fromEntries(restaurants.map(r => [r.name.trim(), r.id]))

  console.log(`Found ${restaurants.length} restaurants. Matching to menu definitions…\n`)

  // Build all rows
  const allRows = []
  const skipped = []

  for (const [restName, items] of Object.entries(MENUS)) {
    const id = idMap[restName]
    if (!id) { skipped.push(restName); continue }
    items.forEach(item => allRows.push({ ...item, restaurant_id: id, is_available: true, photo_url: null }))
  }

  if (skipped.length) console.warn('⚠️  No ID found for:', skipped.join(', '))

  console.log(`Inserting ${allRows.length} menu items across ${Object.keys(MENUS).length - skipped.length} restaurants…\n`)

  // Insert in one batch
  const { data, error } = await sb
    .from('menu_items')
    .insert(allRows)
    .select('id, restaurant_id, name, category, price, is_daily_special')

  if (error) {
    console.error('❌  Insert failed:', error.message)
    console.error('   Code:', error.code, '| Details:', error.details)
    process.exit(1)
  }

  // Group results by restaurant for summary
  const byRest = {}
  data.forEach(item => {
    const restName = restaurants.find(r => r.id === item.restaurant_id)?.name ?? item.restaurant_id
    if (!byRest[restName]) byRest[restName] = []
    byRest[restName].push(item)
  })

  for (const [name, items] of Object.entries(byRest)) {
    const specials = items.filter(i => i.is_daily_special).map(i => i.name)
    console.log(`  ✅  ${name} — ${items.length} items${specials.length ? ` (★ ${specials.join(', ')})` : ''}`)
    items.forEach(i => console.log(`       ${i.category.padEnd(20)} ${String(i.price).padStart(5)} FCFA  ${i.name}`))
    console.log()
  }

  console.log(`\n🎉  Done! ${data.length} menu items inserted successfully.\n`)
}

main()
