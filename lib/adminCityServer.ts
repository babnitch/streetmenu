// Server side of the admin city filter (lib/adminCity.ts): the ?city= of an
// admin list API, or null for every city. An unknown city is ignored (all
// cities). Test runs' per-run city is accepted on the test server only.

import type { NextRequest } from 'next/server'
import { getRefData } from '@/lib/refDataServer'
import { isServedCity } from '@/lib/cities'

export async function adminCityParam(req: NextRequest): Promise<string | null> {
  const v = (req.nextUrl.searchParams.get('city') ?? '').trim()
  if (!v) return null
  await getRefData()
  return isServedCity(v) ? v : null
}
