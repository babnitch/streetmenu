import type { Metadata } from 'next'

// The team login is not for search engines (see also the X-Robots-Tag header
// on /admin/* in next.config.mjs).
export const metadata: Metadata = {
  title: 'Tchop & Ndjoka',
  robots: { index: false, follow: false, nocache: true },
}

export default function AdminLoginLayout({ children }: { children: React.ReactNode }) {
  return children
}
