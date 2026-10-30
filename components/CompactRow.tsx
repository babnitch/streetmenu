'use client'

// Mode économique: one text row per item instead of an image card — small
// category icon, name in bold, one grey line. No image, cover or poster.

import Link from 'next/link'
import { forwardRef, type ReactNode } from 'react'

export const CompactRow = forwardRef<HTMLAnchorElement, {
  href: string; icon: string; title: string; line?: ReactNode; onClick?: () => void
}>(function CompactRow({ href, icon, title, line, onClick }, ref) {
  return (
    <Link ref={ref} href={href} onClick={onClick}
      className="flex items-center gap-3 bg-white border border-divider rounded-xl px-3 py-2.5 hover:bg-surface-muted transition-colors">
      <span className="w-6 text-center text-lg flex-shrink-0" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-ink-primary truncate">{title}</span>
        {line && <span className="block text-xs text-ink-tertiary truncate">{line}</span>}
      </span>
      <span className="text-ink-tertiary flex-shrink-0" aria-hidden="true">›</span>
    </Link>
  )
})

export function CompactList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>
}

/** " · "-joined, empty parts dropped. */
export const dot = (...parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ')
