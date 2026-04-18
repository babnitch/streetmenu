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

export function signSession(payload: SessionPayload, rememberMe = false): string {
  return jwt.sign(payload, SECRET, {
    expiresIn: rememberMe ? '30d' : '24h',
  })
}

export function verifySession(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, SECRET) as SessionPayload
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
  res.cookies.set(COOKIE_NAME, '', { maxAge: 0, path: '/' })
  return res
}
