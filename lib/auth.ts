import jwt from 'jsonwebtoken'
import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'sm_session'
const SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production'

export type SessionRole = 'customer' | 'super_admin' | 'admin' | 'moderator'

export interface SessionPayload {
  id:    string       // customer_id or admin_id
  name:  string
  role:  SessionRole
  phone?: string      // customers only
  email?: string      // admins only
}

// Customers always get 30 days (login is a phone code; fewer logins also
// means fewer paid messages). Admin logins keep "remember me": 24 h or 30 d.
export function signSession(payload: SessionPayload, rememberMe = false): string {
  return jwt.sign(payload, SECRET, {
    expiresIn: rememberMe ? '30d' : '24h',
  })
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const p = jwt.verify(token, SECRET) as SessionPayload & { purpose?: unknown }
    // A sign-up pass is signed with the same secret but is not a session.
    if (!p || typeof p.role !== 'string' || p.purpose !== undefined) return null
    return p
  } catch {
    return null
  }
}

export function getSessionFromRequest(req: NextRequest): SessionPayload | null {
  const token = req.cookies.get(COOKIE_NAME)?.value
  if (!token) return null
  return verifySession(token)
}

export function setSessionCookie(
  res: NextResponse,
  payload: SessionPayload,
  rememberMe = false,
): NextResponse {
  const token = signSession(payload, rememberMe)
  const maxAge = rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
    path: '/',
  })
  return res
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
    path: '/',
  })
  return res
}

// ── Sign-up pass ────────────────────────────────────────────────────────────
// A new number has proved itself with a code but has no account yet: the
// login screen then asks only for a first name. This short-lived signed pass
// carries the verified phone to /api/auth/complete-signup, so the code is
// never asked twice and the phone can't be swapped in between.
const SIGNUP_TTL = '15m'

export function signSignupPass(phone: string): string {
  return jwt.sign({ phone, purpose: 'signup' }, SECRET, { expiresIn: SIGNUP_TTL })
}

export function verifySignupPass(token: unknown): string | null {
  if (typeof token !== 'string' || !token) return null
  try {
    const p = jwt.verify(token, SECRET) as { phone?: unknown; purpose?: unknown }
    return p.purpose === 'signup' && typeof p.phone === 'string' ? p.phone : null
  } catch {
    return null
  }
}

// Log a customer in: 30-day session cookie.
export function setCustomerSession(
  res: NextResponse,
  customer: { id: string; phone: string; name: string },
): NextResponse {
  return setSessionCookie(res, { id: customer.id, phone: customer.phone, name: customer.name, role: 'customer' }, true)
}
