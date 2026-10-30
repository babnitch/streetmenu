// Mapbox forward geocoding for the imports (I3, I5): a point is kept ONLY
// when Mapbox finds the place itself (a POI or a street address) inside the
// city's box; a match on the whole city or a district centre is not a
// location → no point (no map pin).

export const CITY_BOX: Record<string, [number, number, number, number]> = {
  // [minLng, minLat, maxLng, maxLat]
  'Yaoundé': [11.40, 3.74, 11.62, 3.99],
  'Douala':  [9.60, 3.93, 9.86, 4.16],
}

export interface GeoResult { lat: number; lng: number; kind: string; label: string }

export function insideCity(city: string, lng: number, lat: number): boolean {
  const b = CITY_BOX[city]
  return !!b && lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]
}

export async function geocode(query: string, city: string): Promise<GeoResult | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  const box = CITY_BOX[city]
  if (!token || !box) return null
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
    `?access_token=${token}&country=cm&limit=1&types=poi,address&bbox=${box.join(',')}&language=fr`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Mapbox ${res.status}`)
  const d = await res.json() as { features?: Array<{ center: [number, number]; place_type: string[]; place_name: string }> }
  const f = d.features?.[0]
  if (!f) return null
  const [lng, lat] = f.center
  if (!insideCity(city, lng, lat)) return null
  return { lat, lng, kind: f.place_type[0], label: f.place_name }
}

// OpenStreetMap (Nominatim) fallback, for landmarks Mapbox does not have in
// Cameroon. Bounded to the city's box; a district, a road or the city itself
// is not a location. Nominatim's policy: max 1 request per second and a
// User-Agent naming the app — geocodeOsm waits 1.1 s before each call.
const OSM_SKIP_CLASSES = new Set(['boundary', 'place', 'highway', 'landuse'])
// The found name must share a distinctive word with ours ("Marché Mfoundi"
// must not land on a post office that merely sits nearby).
const GENERIC = new Set(['marche', 'musee', 'cathedrale', 'eglise', 'mosquee', 'temple', 'yaounde', 'douala', 'cameroun', 'camerounais', 'cameroon',
  'boulevard', 'avenue', 'rue', 'place', 'centre', 'central', 'grand', 'grande', 'national', 'nationale', 'restaurant', 'parc', 'jardin'])
function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
function words(s: string): string[] {
  return norm(s).split(' ').filter(w => w.length >= 4 && !GENERIC.has(w))
}
export function sameName(ours: string, found: string): boolean {
  const a = norm(ours), b = norm(found)
  // "Grande Mosquée" inside "Grande Mosquée de Yaoundé" — whole names only.
  if (b.split(' ').length >= 2 && (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `))) return true
  const theirs = new Set(words(found))
  return words(ours).some(w => theirs.has(w))
}

export async function geocodeOsm(query: string, city: string): Promise<GeoResult | null> {
  const box = CITY_BOX[city]
  if (!box) return null
  await new Promise(r => setTimeout(r, 1100))
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&countrycodes=cm&bounded=1` +
    `&viewbox=${box[0]},${box[3]},${box[2]},${box[1]}&q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'TchopNdjoka-import/1.0 (contact via tchopndjoka)', 'Accept-Language': 'fr' } })
  if (!res.ok) throw new Error(`OSM ${res.status}`)
  const d = await res.json() as Array<{ lat: string; lon: string; category?: string; class?: string; type: string; display_name: string }>
  // The first of the top 3 that is a place (not a district / road) of the
  // same name, inside the city.
  const f = d.find(x => !OSM_SKIP_CLASSES.has(x.category ?? x.class ?? '')
    && sameName(query.split(',')[0], x.display_name.split(',')[0])
    && insideCity(city, Number(x.lon), Number(x.lat)))
  if (!f) return null
  const lat = Number(f.lat), lng = Number(f.lon)
  return { lat, lng, kind: `osm:${f.category ?? f.class}/${f.type}`, label: f.display_name }
}
