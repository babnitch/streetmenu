// Seed script — 10 Yaoundé restaurants
// Run: node scripts/seed-yaounde.mjs

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://xylfxtdgpptvieobvlfj.supabase.co'
const SUPABASE_KEY = 'sb_publishable_BeQNT7anFNpd29SqnseHPQ_E_IHwK-x'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Step 1: Introspect live columns ────────────────────────────────────────
async function getLiveColumns() {
  const { data, error } = await supabase
    .from('restaurants')
    .select('*')
    .limit(1)

  if (error) {
    console.error('❌ Could not read restaurants table:', error.message)
    process.exit(1)
  }

  // If table is empty, fall back to known baseline
  if (!data || data.length === 0) {
    console.log('ℹ️  Table is empty — will detect columns from a test insert probe.')
    return null
  }

  const cols = Object.keys(data[0])
  console.log('✅ Live columns detected:\n  ', cols.join(', '))
  return new Set(cols)
}

// ── Step 2: Restaurant data ────────────────────────────────────────────────
const RESTAURANTS = [
  {
    name: 'Chez Mama Biya',
    description: 'Poulet DG',
    cuisine_type: 'Poulet DG',
    address: 'Bastos, Avenue Kennedy',
    neighborhood: 'Bastos',
    city: 'Yaoundé',
    lat: 3.8817,
    lng: 11.5156,
    phone: '+237 677 001 101',
    whatsapp: '+237677001101',
    logo_url: 'https://images.unsplash.com/photo-1604908177453-7462950a6a3b?w=800&auto=format&fit=crop',
    is_open: true,
    is_active: true,
  },
  {
    name: 'Le Braiseur du Centre',
    description: 'Grillades',
    cuisine_type: 'Grillades',
    address: 'Centre-ville, Rue Nachtigal',
    neighborhood: 'Centre-ville',
    city: 'Yaoundé',
    lat: 3.8667,
    lng: 11.5167,
    phone: '+237 690 002 202',
    whatsapp: '+237690002202',
    logo_url: 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop',
    is_open: true,
    is_active: true,
  },
  {
    name: 'Maquis Mvog-Ada',
    description: 'Street food camerounais',
    cuisine_type: 'Street food',
    address: 'Mvog-Ada, Carrefour Warda',
    neighborhood: 'Mvog-Ada',
    city: 'Yaoundé',
    lat: 3.8595,
    lng: 11.5217,
    phone: '+237 655 003 303',
    whatsapp: '+237655003303',
    logo_url: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800&auto=format&fit=crop',
    is_open: true,
    is_active: true,
  },
  {
    name: 'Restaurant Fouda & Fils',
    description: 'Camerounais traditionnel',
    cuisine_type: 'Camerounais traditionnel',
    address: 'Nlongkak, Rue de la Réunification',
    neighborhood: 'Nlongkak',
    city: 'Yaoundé',
    lat: 3.8730,
    lng: 11.5050,
    phone: '+237 699 004 404',
    whatsapp: '+237699004404',
    logo_url: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=800&auto=format&fit=crop',
    is_open: true,
    is_active: true,
  },
  {
    name: 'Chez Tantine Adjoua',
    description: 'Cuisine camerounaise',
    cuisine_type: 'Cuisine camerounaise',
    address: 'Mokolo, Marché Central',
    neighborhood: 'Mokolo',
    city: 'Yaoundé',
    lat: 3.8763,
    lng: 11.5080,
    phone: '+237 677 005 505',
    whatsapp: '+237677005505',
    logo_url: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800&auto=format&fit=crop',
    is_open: false,
    is_active: true,
  },
  {
    name: 'Grillade Etoudi Palace',
    description: 'Poulet braisé',
    cuisine_type: 'Poulet braisé',
    address: 'Etoudi, Près du Palais',
    neighborhood: 'Etoudi',
    city: 'Yaoundé',
    lat: 3.8950,
    lng: 11.5283,
    phone: '+237 690 006 606',
    whatsapp: '+237690006606',
    logo_url: 'https://images.unsplash.com/photo-1598511726623-d2e9996892f0?w=800&auto=format&fit=crop',
    is_open: true,
    is_active: true,
  },
  {
    name: 'Le Bord du Lac — Melen',
    description: 'Poisson braisé',
    cuisine_type: 'Poisson braisé',
    address: 'Melen, Avenue du Lac',
    neighborhood: 'Melen',
    city: 'Yaoundé',
    lat: 3.8650,
    lng: 11.5320,
    phone: '+237 655 007 707',
    whatsapp: '+237655007707',
    logo_url: 'https://images.unsplash.com/photo-1544943910-4c1dc44aab44?w=800&auto=format&fit=crop',
    is_open: true,
    is_active: true,
  },
  {
    name: 'Snack Biyem-Assi Express',
    description: 'Street food',
    cuisine_type: 'Street food',
    address: 'Biyem-Assi, Carrefour Principal',
    neighborhood: 'Biyem-Assi',
    city: 'Yaoundé',
    lat: 3.8428,
    lng: 11.4978,
    phone: '+237 699 008 808',
    whatsapp: '+237699008808',
    logo_url: 'https://images.unsplash.com/photo-1567620832903-9fc6debc209f?w=800&auto=format&fit=crop',
    is_open: true,
    is_active: true,
  },
  {
    name: 'Al-Wadi Libanais',
    description: 'Libanais',
    cuisine_type: 'Libanais',
    address: 'Bastos, Rue 1.820',
    neighborhood: 'Bastos',
    city: 'Yaoundé',
    lat: 3.8830,
    lng: 11.5140,
    phone: '+237 677 009 909',
    whatsapp: '+237677009909',
    logo_url: 'https://images.unsplash.com/photo-1544025162-d76538f56d6c?w=800&auto=format&fit=crop',
    is_open: true,
    is_active: true,
  },
  {
    name: 'La Terrasse de Briqueterie',
    description: 'Camerounais traditionnel',
    cuisine_type: 'Camerounais traditionnel',
    address: 'Briqueterie, Rue du Marché',
    neighborhood: 'Briqueterie',
    city: 'Yaoundé',
    lat: 3.8680,
    lng: 11.5245,
    phone: '+237 690 010 010',
    whatsapp: '+237690010010',
    logo_url: 'https://images.unsplash.com/photo-1516685018646-549198525c1b?w=800&auto=format&fit=crop',
    is_open: false,
    is_active: true,
  },
]

// ── Step 3: Build row using only columns that exist ────────────────────────
function buildRow(data, liveColumns) {
  if (!liveColumns) return data // table was empty — try full insert

  const row = {}
  for (const [key, value] of Object.entries(data)) {
    // Always include base columns even if not in the sample row
    const baseColumns = ['name','description','address','lat','lng','phone',
                         'whatsapp','logo_url','is_open','city','is_active']
    if (liveColumns.has(key) || baseColumns.includes(key)) {
      row[key] = value
    }
  }
  return row
}

// ── Step 4: Insert ──────────────────────────────────────────────────────────
async function main() {
  console.log('\n🌍  Seeding Yaoundé restaurants into Supabase…\n')

  // Introspect
  const liveColumns = await getLiveColumns()

  // Build rows
  const rows = RESTAURANTS.map(r => buildRow(r, liveColumns))

  // Insert all at once
  const { data, error } = await supabase
    .from('restaurants')
    .insert(rows)
    .select('id, name, neighborhood, city, is_open')

  if (error) {
    console.error('\n❌  Insert failed:', error.message)
    console.error('   Code:', error.code)
    console.error('   Details:', error.details)

    // Try inserting without vendor-signup columns
    if (error.code === '42703') {
      console.log('\n⚠️   Unknown column detected — retrying without vendor signup columns…')
      const safeRows = RESTAURANTS.map(r => ({
        name: r.name,
        description: r.description,
        address: r.address,
        city: r.city,
        lat: r.lat,
        lng: r.lng,
        phone: r.phone,
        whatsapp: r.whatsapp,
        logo_url: r.logo_url,
        is_open: r.is_open,
        is_active: r.is_active,
      }))

      const { data: data2, error: error2 } = await supabase
        .from('restaurants')
        .insert(safeRows)
        .select('id, name, city')

      if (error2) {
        console.error('\n❌  Retry also failed:', error2.message)
        process.exit(1)
      }

      console.log(`\n✅  Inserted ${data2.length} restaurants (base columns only):\n`)
      data2.forEach((r, i) => console.log(`  ${i + 1}. ${r.name} — ${r.city} [${r.id.slice(0, 8)}]`))
      return
    }

    process.exit(1)
  }

  console.log(`\n✅  Successfully inserted ${data.length} / ${RESTAURANTS.length} restaurants:\n`)
  data.forEach((r, i) => {
    const status = r.is_open ? '🟢 open' : '🔴 closed'
    console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(35)} ${r.neighborhood ?? r.city}  ${status}`)
  })
  console.log('\n🎉  Done! Refresh the home page to see them on the map and in the list.\n')
}

main()
