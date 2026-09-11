import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

// Role-based landing redirect — the ONLY thing this middleware does.
//
// An admin opening the app at "/" used to get the customer restaurant feed,
// because app/page.tsx never reads the session at all (its governing comment
// says "/ is the public landing page for everyone — logged out, customers,
// and vendors alike", which predates admins existing). Their only way into
// the console was the Compte link in TopNav. This sends them straight there.
//
// WHY MIDDLEWARE RATHER THAN app/page.tsx. The redirect has to happen BEFORE
// any render, or the admin sees the customer feed paint and then vanish —
// the same flash class the dashboard was fixed for. app/page.tsx has no
// session state and no /api/auth/me call, so doing it there would mean adding
// a fetch-then-redirect to the highest-traffic page and accepting that flash.
// Here the cookie is read server-side and nothing renders first.
//
// WHY jose RATHER THAN lib/auth.ts. lib/auth.ts uses `jsonwebtoken`, which
// imports Node's `crypto` (jsonwebtoken/verify.js:9, jwa/index.js:2) and so
// cannot run on the Edge runtime. Next 14.2 middleware is Edge-only — the
// Node.js middleware runtime only arrives in Next 15.2 — so there is no
// runtime escape hatch on this version. jose is edge-native and verifies the
// SAME HS256 signature that lib/auth.ts signSession() produces with the same
// JWT_SECRET, including expiry. Verification is not weakened: the signature
// and exp are both checked, and a token that fails either is treated as no
// token at all.

const COOKIE_NAME = 'sm_session'
const ADMIN_ROLES = ['super_admin', 'admin', 'moderator']

// Must match lib/auth.ts's SECRET exactly, including the dev fallback, or a
// locally-issued session would fail to verify here while working everywhere
// else.
const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
)

export async function middleware(req: NextRequest) {
  // Defence in depth. The matcher below already restricts this to "/", but
  // matcher entries are OR'd, so ANY future entry added there widens the
  // scope. This guard means a careless widening cannot turn the landing
  // redirect into an app-wide one — the function simply does nothing
  // anywhere but the landing page.
  if (req.nextUrl.pathname !== '/') return NextResponse.next()

  const token = req.cookies.get(COOKIE_NAME)?.value
  // No cookie → nothing to decide. This is the overwhelmingly common case
  // (logged-out visitors), and it costs one map lookup.
  if (!token) return NextResponse.next()

  let role: unknown
  try {
    // Verifies the HS256 signature AND exp. Throws on a bad signature, a
    // tampered payload, an expired token or a malformed string.
    const { payload } = await jwtVerify(token, SECRET)
    role = payload.role
  } catch {
    // FAIL OPEN, deliberately. A missing, malformed, forged or expired
    // cookie must leave "/" exactly as it is today rather than bounce the
    // visitor somewhere. This middleware is a convenience for admins, not a
    // security boundary — /account does its own authorization regardless of
    // how the visitor arrived.
    return NextResponse.next()
  }

  if (typeof role !== 'string' || !ADMIN_ROLES.includes(role)) {
    // Customers and vendors keep the public landing page untouched.
    return NextResponse.next()
  }

  // /account resolves dashView to 'admin' for these roles, so this lands on
  // the admin console. It is outside the matcher below, so it can never
  // redirect back — there is no loop to create.
  const url = req.nextUrl.clone()
  url.pathname = '/account'
  return NextResponse.redirect(url)
}

export const config = {
  // The landing page and NOTHING else. A literal path, so it never matches
  // /account, /dashboard, any of the 132 /api routes, /_next, or a static
  // asset. A matcher that fired on every request would put a JWT
  // verification in front of the whole app, which is the real risk here.
  //
  // Deliberately a single entry: matcher entries are OR'd, so adding a
  // second one WIDENS this rather than narrowing it. The pathname check at
  // the top of middleware() is the guard against that happening by accident.
  matcher: ['/'],
}
