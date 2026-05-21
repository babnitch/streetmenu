// Per-key sliding-window rate limiter.
//
// In-memory by design — Vercel serverless instances are short-lived,
// so a malicious client that lands across instances effectively gets
// (instance-count × quota) per window. That's still meaningfully
// protective at our current scale; a Redis-backed limiter is in the
// security backlog for when we cross 100 req/s.
//
// Usage:
//
//   import { rateLimit, rateLimitedResponse } from '@/lib/rateLimit'
//   const limited = rateLimit({ key: `send-code:${phone}`, max: 5, windowMs: 3600_000 })
//   if (limited) return rateLimitedResponse(limited)

import { NextResponse } from 'next/server'

interface Bucket {
  // Unix-ms timestamps of recent hits, oldest first.
  hits: number[]
  // When the oldest hit will expire — used by the sweeper.
  resetAt: number
}

const BUCKETS = new Map<string, Bucket>()
// Sweep stale buckets every 60s so a long-lived instance doesn't grow
// unbounded under attack. Each iteration only touches expired keys.
let lastSweep = 0
function sweep(nowMs: number) {
  if (nowMs - lastSweep < 60_000) return
  lastSweep = nowMs
  // Map iteration via forEach so we don't need downlevelIteration
  // in tsconfig (which would affect the rest of the codebase).
  BUCKETS.forEach((b, k) => {
    if (b.resetAt < nowMs) BUCKETS.delete(k)
  })
}

export interface RateLimitOpts {
  key:      string
  max:      number       // allowed hits per window
  windowMs: number
}

export interface RateLimitResult {
  retryAfterSec: number
  message:       string
}

// Returns null when the request is allowed (counter incremented).
// Returns a RateLimitResult when the call should be rejected.
export function rateLimit(opts: RateLimitOpts): RateLimitResult | null {
  const now = Date.now()
  sweep(now)

  const cutoff = now - opts.windowMs
  const bucket = BUCKETS.get(opts.key) ?? { hits: [], resetAt: now + opts.windowMs }
  // Drop hits that have fallen out of the sliding window.
  bucket.hits = bucket.hits.filter(t => t > cutoff)

  if (bucket.hits.length >= opts.max) {
    const oldest = bucket.hits[0]
    const retryAfterMs = Math.max(0, oldest + opts.windowMs - now)
    return {
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
      message:       `Trop de requêtes. Réessayez dans ${Math.ceil(retryAfterMs / 1000)} secondes. / Too many requests. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
    }
  }

  bucket.hits.push(now)
  bucket.resetAt = now + opts.windowMs
  BUCKETS.set(opts.key, bucket)
  return null
}

// Standard 429 with Retry-After. Returns a NextResponse so callers can
// `return rateLimitedResponse(result)` directly.
export function rateLimitedResponse(r: RateLimitResult): NextResponse {
  return NextResponse.json(
    { error: r.message, retry_after: r.retryAfterSec },
    { status: 429, headers: { 'Retry-After': String(r.retryAfterSec) } },
  )
}

// Best-effort caller IP from common Vercel / Cloudflare headers. Falls
// back to a literal so the limiter never throws on missing headers.
import type { NextRequest } from 'next/server'
export function clientIP(req: NextRequest): string {
  const xfwd = req.headers.get('x-forwarded-for')
  if (xfwd) return xfwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}
