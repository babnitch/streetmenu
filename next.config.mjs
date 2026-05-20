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
    return [
      // HTML pages — browser must revalidate on every navigation so a
      // fresh deploy is picked up without a hard refresh. Vercel still
      // returns 304 when the ETag matches, so the cost is header-only.
      {
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
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
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ]
  },
}

export default nextConfig
