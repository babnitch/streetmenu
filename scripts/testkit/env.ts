// Shared environment for every test suite.
//
// Replaces the copy-pasted .env.local loader + createClient block at the top
// of the ten scripts/test-*.ts files. Import this first from any suite; the
// loader runs on import so process.env is populated before anything else
// reads it.
//
// Deliberately lazy about Supabase: `sb` only builds a client on first
// property access, so the pure-logic unit suites run with no credentials at
// all (`npm run test:unit` needs nothing but node_modules).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { randomBytes } from 'crypto'

// ── .env.local ──────────────────────────────────────────────────────────────
// Same parser the existing scripts use: KEY=value, quotes stripped, and a
// real environment variable always wins over the file.
let loaded = false
export function loadEnvLocal(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
      if (!m) continue
      const [, k, vRaw] = m
      const v = vRaw.replace(/^["']|["']$/g, '')
      if (!process.env[k]) process.env[k] = v
    }
  } catch {
    // No .env.local — fine for unit suites, fatal later for DB/API ones,
    // which surface it through requireSupabaseEnv().
  }
}
loadEnvLocal()

// ── Run identity ────────────────────────────────────────────────────────────
// The runner exports TEST_RUN_ID so every child suite shares one id and the
// sweeper can recognise a single run's residue. A suite launched directly
// (`tsx scripts/suites/unit-phone-and-text.ts`) mints its own.
export const RUN_ID: string =
  process.env.TEST_RUN_ID && /^[0-9a-f]{6}$/.test(process.env.TEST_RUN_ID)
    ? process.env.TEST_RUN_ID
    : randomBytes(3).toString('hex')

// ── Targets ─────────────────────────────────────────────────────────────────
export const BASE: string = process.env.BASE_URL ?? 'http://localhost:3001'
export const JWT_SECRET: string = process.env.JWT_SECRET ?? 'dev-secret-change-in-production'

export function isSupabaseConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export function requireSupabaseEnv(): void {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set (check .env.local)')
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set (check .env.local)')
  }
}

// ── Service-role client ─────────────────────────────────────────────────────
// Lazy via Proxy, mirroring lib/supabaseAdmin.ts: a unit suite that never
// touches `sb` never needs the keys, but `sb.from(...)` still reads naturally
// in DB suites.
let _client: SupabaseClient | null = null
export function getSb(): SupabaseClient {
  if (!_client) {
    requireSupabaseEnv()
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    )
  }
  return _client
}

export const sb = new Proxy({} as SupabaseClient, {
  get(_t, prop) {
    return (getSb() as unknown as Record<string | symbol, unknown>)[prop]
  },
})

// ── Anon (browser) client ───────────────────────────────────────────────────
// The SAME client the browser gets from lib/supabase.ts: public URL + public
// anon key, no session. Used by the RLS section of db-schema-migrations.ts to
// measure what an unauthenticated visitor can actually read.
//
// This is the only honest way to check RLS from here. PostgREST does not
// expose pg_catalog, so `pg_policies` is unreadable and there is no
// DATABASE_URL in .env.local to go around it. Comparing what THIS client sees
// against what `sb` (service role, bypasses RLS) sees is the measurable proxy
// for a policy, and it has the advantage of testing the thing that actually
// matters — what a stranger with the public key can read — rather than the
// policy text that is supposed to produce it.
//
// Lazy for the same reason `sb` is: a unit suite that never touches it needs
// no credentials.
let _anon: SupabaseClient | null = null
export function getAnon(): SupabaseClient {
  if (!_anon) {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set (check .env.local)')
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set (check .env.local)')
    }
    _anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    )
  }
  return _anon
}

export const anonSb = new Proxy({} as SupabaseClient, {
  get(_t, prop) {
    return (getAnon() as unknown as Record<string | symbol, unknown>)[prop]
  },
})

// ── Reserved namespace ──────────────────────────────────────────────────────
// See TEST-PLAN.md §4. Everything a test creates must be nameable by one of
// these patterns, because the sweeper works from patterns alone — it never
// depends on the ledger having survived.

// +999<2-digit suite><4-digit seq>. +999 is not an assignable country code,
// so a row matching it can never be a real customer.
export const TEST_PHONE_PREFIX = '+999'

export function testPhone(suiteNo: number, seq: number): string {
  const s = String(suiteNo).padStart(2, '0').slice(-2)
  const q = String(seq).padStart(4, '0').slice(-4)
  return `${TEST_PHONE_PREFIX}${s}${q}`
}

// Restaurant / event / menu-item names.
export function testName(label: string, runId: string = RUN_ID): string {
  return `__t_${runId}_${label}__`
}

// Voucher codes. The WHOLE code must be uppercase, run id included: every
// voucher lookup normalises input with .toUpperCase() before matching
// (app/api/customer/vouchers/claim/route.ts:19), so a code containing the
// lowercase hex run id could never be found again.
export function testCode(label: string, runId: string = RUN_ID): string {
  return `__T_${runId.toUpperCase()}_${label.toUpperCase()}__`
}

// Matches any run's names, not just this one — what the sweeper needs.
export const TEST_NAME_LIKE = '\\_\\_t\\_%'
export const TEST_CODE_LIKE = '\\_\\_T\\_%'
export const TEST_PHONE_LIKE = '+999%'
