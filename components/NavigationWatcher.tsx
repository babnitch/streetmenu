'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { suppressInitialRedirect } from '@/lib/initialRedirect'

// Mounted once at the layout level. Its job is to detect when the user
// has navigated (Link click, back/forward, programmatic push) and mark
// the vendor "land on / → /dashboard" auto-redirect as suppressed.
//
// The very first render is the cold entry URL of the session — we leave
// the flag alone so app/page.tsx can still trigger its one bounce for
// vendors who actually land cold on /. Every pathname change after that
// is a deliberate navigation and should never be undone by the bounce.
//
// Placement MATTERS: this component must render BEFORE {children} in
// app/layout.tsx so its useEffect runs before any descendant page's
// redirect effect that depends on the suppression flag.
export default function NavigationWatcher() {
  const pathname = usePathname()
  const initial = useRef(true)

  useEffect(() => {
    if (initial.current) {
      initial.current = false
      return
    }
    suppressInitialRedirect()
  }, [pathname])

  return null
}
