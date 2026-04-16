import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Server-only client — uses service role key, never expose to browser.
// Lazy-initialised so the build phase never calls createClient with missing env vars.
let _client: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )
  }
  return _client
}

// Convenience proxy — same API as before but only initialised on first property access
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabaseAdmin() as unknown as Record<string | symbol, unknown>)[prop]
  },
})
