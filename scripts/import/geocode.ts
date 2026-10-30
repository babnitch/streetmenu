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
