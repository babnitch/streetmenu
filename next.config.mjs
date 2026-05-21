/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.supabase.co' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: '**.unsplash.com' },
    ],
    // Prefer WebP / AVIF (smaller than JPEG) when the browser supports
    // the Accept header. Vercel does the encoding on the edge.
    formats: ['image/webp', 'image/avif'],
    // Device + image sizes mostly match our card layouts (320 mobile,
    // 640 tablet, 1024 desktop) plus the thumb (80) + thumbnail (200)
    // sizes used by menu items and logos. Trimming the size set keeps
    // the on-demand encoded variant count down.
    deviceSizes: [320, 420, 640, 768, 1024],
    imageSizes: [80, 200, 400, 800],
    // 24h CDN cache for upstream images — anything served from
    // Supabase already declares cacheControl=86400 on upload, but
    // Next can still re-fetch sooner if minimumCacheTTL is short.
    minimumCacheTTL: 86400,
  },

  // Cache policy — written from "most generic" to "most specific" because
  // Next.js applies matching rules in order and the LAST one wins for the
  // same header key. A new deploy must surface immediately for HTML pages
  // (otherwise users see stale chunks pointing at non-existent JS) but the
  // hashed _next/static/* artifacts are safe to cache forever.
  async headers() {
    // Defense-in-depth headers applied to every response. The CSP allow-list
    // covers the third-party origins we actually use:
    //   - Supabase    (REST + storage + realtime WebSocket)
    //   - Mapbox      (tiles + style + glyphs)
    //   - Twilio      (incoming media URLs we proxy through downloadTwilioMedia)
    //   - PawaPay     (sandbox + prod, status polls)
    //   - data:/blob: (camera capture previews, blur placeholders)
    //
    // 'unsafe-inline' on script + style is required by Next.js — its
    // hydration scripts inline a state blob, and Tailwind ships utility
    // classes via inline styles in some components. Tightening this
    // needs a nonce-based CSP which is a Next.js 15+ pattern; tracked
    // in SECURITY-AUDIT.md.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.supabase.co https://*.mapbox.com https://*.unsplash.com",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.mapbox.com https://events.mapbox.com https://api.twilio.com https://api.sandbox.pawapay.io https://api.pawapay.io",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; ')

    const SECURITY_HEADERS = [
      { key: 'X-Frame-Options',         value: 'DENY' },
      { key: 'X-Content-Type-Options',  value: 'nosniff' },
      { key: 'Referrer-Policy',         value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy',      value: 'camera=(self), microphone=(), geolocation=(self), interest-cohort=()' },
      { key: 'Content-Security-Policy', value: csp },
    ]

    return [
      // HTML pages — browser must revalidate on every navigation so a
      // fresh deploy is picked up without a hard refresh. Vercel still
      // returns 304 when the ETag matches, so the cost is header-only.
      // Security headers ride alongside the cache rule.
      {
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
          ...SECURITY_HEADERS,
        ],
      },
      // Static build artifacts — Next.js fingerprints filenames, so they
      // are safe to cache for a year. `immutable` lets the browser skip
      // the revalidation roundtrip entirely.
      {
        source: '/_next/static/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      // API responses — never cached anywhere. Most routes are auth-gated
      // dynamic lookups; a stale cached response is worse than an extra
      // roundtrip.
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control',          value: 'no-store' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy',        value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
