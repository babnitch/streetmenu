/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
      {
        protocol: 'https',
        hostname: '**.unsplash.com',
      },
    ],
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
