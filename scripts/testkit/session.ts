// Forged sessions + a fetch wrapper for the API suites.
//
// Lifted from the cookie helpers duplicated across test-vouchers.ts,
// test-vendor-order-actions.ts and friends. The JWT is signed with the same
// JWT_SECRET the server verifies with, so this only works against a server
// running with the same secret — localhost, or a deployment whose secret you
// have locally (TEST-PLAN.md §0).

import jwt from 'jsonwebtoken'
import { sb, BASE, JWT_SECRET } from './env'

export interface SessionCustomer {
  id:    string
  phone: string
  name:  string
}

// A customer session cookie. Short expiry — a suite never runs an hour.
export function customerCookie(u: SessionCustomer): string {
  const token = jwt.sign(
    { id: u.id, phone: u.phone, name: u.name, role: 'customer' },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  return `sm_session=${token}`
}

// A staff session cookie for an arbitrary role, without going through
// /api/auth/admin-login (which the plan excludes — real bcrypt against real
// admin_users, and repeated failures can trip lockout).
export function staffCookie(u: { id: string; email: string; name: string; role: string }): string {
  const token = jwt.sign(
    { id: u.id, email: u.email, name: u.name, role: u.role },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  return `sm_session=${token}`
}

// Borrows a real super_admin row's identity. Read-only against admin_users:
// we only sign a token, never write. Cached per process.
let cachedAdmin: string | null = null
export async function adminCookie(): Promise<string> {
  if (cachedAdmin) return cachedAdmin
  const { data, error } = await sb
    .from('admin_users')
    .select('id, email, name, role')
    .eq('role', 'super_admin')
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`adminCookie: ${error.message}`)
  if (!data) throw new Error('adminCookie: no super_admin row in admin_users')
  cachedAdmin = staffCookie(data as { id: string; email: string; name: string; role: string })
  return cachedAdmin
}

export interface ApiResponse<T = unknown> {
  status: number
  ok:     boolean
  body:   T
  raw:    string
}

export interface ApiOptions {
  method?:  string
  cookie?:  string
  body?:    unknown
  headers?: Record<string, string>
  /** Send as application/x-www-form-urlencoded — the Twilio webhook shape. */
  form?:    Record<string, string>
}

// One fetch wrapper for every API suite. Never throws on a non-2xx: the
// status is part of what the suites assert, so a 403 is data, not an error.
// Only a transport failure throws.
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<ApiResponse<T>> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.cookie) headers['Cookie'] = opts.cookie

  let body: string | undefined
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(opts.form).toString()
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const res = await fetch(url, {
    method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
  })
  const raw = await res.text()
  let parsed: unknown = raw
  try { parsed = raw ? JSON.parse(raw) : null } catch { /* keep the raw text */ }

  return { status: res.status, ok: res.ok, body: parsed as T, raw }
}

// Is a server listening and speaking our API? An unauthenticated
// /api/auth/me answers 200 with {user:null} or 401 depending on the route's
// shape; either proves the server is up. A transport error means it is not.
export async function serverIsUp(): Promise<boolean> {
  try {
    const r = await api('/api/auth/me')
    return r.status > 0 && r.status < 500
  } catch {
    return false
  }
}
