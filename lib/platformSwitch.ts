// Server-only: the two platform switches (M6) — Restaurants on/off and
// Événements on/off for the whole platform. Stored in platform_settings
// (restaurants_enabled / events_enabled, jsonb true|false), changed by
// admins only, audited.
//
// When a side is off: its customer pages say "temporairement indisponible"
// (components/PlatformGate.tsx), its customer APIs refuse (503, reason
// platform_off), the bot replies unavailable. Never blocked: payment
// webhooks / status / reconcile (money in flight still settles), pro
// dashboards and organiser tools (orders and door checks can be finished),
// and Admin.
//
// Read with a 30-second cache per server instance: a switch takes effect
// within 30 s everywhere (at once on the instance that changed it).

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { pickLang, type Lang } from '@/lib/whatsapp'
import { testGuardPrefix } from '@/lib/testGuard'

export type PlatformSide = 'restaurants' | 'events'
export interface PlatformStatus { restaurants: boolean; events: boolean }

// Under the test send guard (the local +999 test server, never production —
// lib/testGuard.ts) the switches use their own rows, so a test that flips one
// can never close the live platform.
const PREFIX = testGuardPrefix() ? 'test_' : ''
const KEYS: Record<PlatformSide, string> = { restaurants: `${PREFIX}restaurants_enabled`, events: `${PREFIX}events_enabled` }
// audit_log.target_id is a uuid: one fixed id per switch.
const AUDIT_IDS: Record<PlatformSide, string> = {
  restaurants: '00000000-0000-0000-0000-00000000a001',
  events:      '00000000-0000-0000-0000-00000000a002',
}
const TTL_MS = 30_000
let cache: { at: number; value: PlatformStatus } | null = null

export async function getPlatformStatus(): Promise<PlatformStatus> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  const { data, error } = await supabaseAdmin.from('platform_settings')
    .select('key, value').in('key', Object.values(KEYS))
  // Unreadable → stay open: a settings outage must not close the platform.
  const read = (side: PlatformSide) => {
    if (error) return true
    const row = (data ?? []).find(r => r.key === KEYS[side])
    return row ? row.value !== false : true
  }
  const value = { restaurants: read('restaurants'), events: read('events') }
  cache = { at: Date.now(), value }
  return value
}

export async function isSideOn(side: PlatformSide): Promise<boolean> {
  return (await getPlatformStatus())[side]
}

export const PLATFORM_OFF_TEXT: Record<PlatformSide, { fr: string; en: string }> = {
  restaurants: { fr: 'Les restaurants sont temporairement indisponibles.', en: 'Restaurants are temporarily unavailable.' },
  events:      { fr: 'Les événements sont temporairement indisponibles.', en: 'Events are temporarily unavailable.' },
}

// null when the side is on, else the 503 to return.
export async function requireSideOn(side: PlatformSide): Promise<NextResponse | null> {
  if (await isSideOn(side)) return null
  const t = PLATFORM_OFF_TEXT[side]
  return NextResponse.json({ error: `${t.fr} / ${t.en}`, reason: 'platform_off', side }, { status: 503 })
}

export function platformOffReply(side: PlatformSide, lang: Lang): string {
  const t = PLATFORM_OFF_TEXT[side]
  return `⏸️ ${pickLang(t.fr, t.en, lang)} ${pickLang('Réessayez plus tard.', 'Please try again later.', lang)}`
}

export async function setSide(side: PlatformSide, on: boolean, admin: { id: string; type: string }): Promise<void> {
  const before = await getPlatformStatus()
  const { error } = await supabaseAdmin.from('platform_settings')
    .upsert({ key: KEYS[side], value: on, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) throw new Error(error.message)
  cache = null
  if (before[side] !== on) {
    await writeAudit({
      action: 'platform_switch_updated', targetType: 'platform', targetId: AUDIT_IDS[side],
      performedBy: admin.id, performedByType: admin.type,
      previousData: { [KEYS[side]]: before[side] }, metadata: { [KEYS[side]]: on },
    })
  }
}
