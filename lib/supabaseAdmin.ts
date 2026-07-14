import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Server-only client — uses service role key, never expose to browser.
// Lazy-initialised so the build phase never calls createClient with missing env vars.
let _client: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    // Fail LOUDLY when the service-role key is missing. Without this guard
    // createClient(url, undefined) silently returns a client with no auth —
    // it behaves like the anon key, so every "admin" read is quietly filtered
    // by RLS (e.g. /api/events/my would return only is_active=true events and
    // drop the organizer's own pending ones). A clear 500 beats that silent,
    // near-undebuggable data loss. Usually means the env var isn't set in the
    // deployment (Vercel → Settings → Environment Variables).
    if (!url) throw new Error('[supabaseAdmin] NEXT_PUBLIC_SUPABASE_URL is not set')
    if (!key) throw new Error('[supabaseAdmin] SUPABASE_SERVICE_ROLE_KEY is not set — admin client would silently fall back to RLS-restricted anon access')
    _client = createClient(url, key, { auth: { persistSession: false } })
  }
  return _client
}

// Convenience proxy — same API as before but only initialised on first property access
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabaseAdmin() as unknown as Record<string | symbol, unknown>)[prop]
  },
})
