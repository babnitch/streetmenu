'use client'

// One-shot suppress flag for the vendor "land on / → bounce to /dashboard"
// auto-redirect in app/page.tsx.
//
// Lives in module memory, which persists across client-side navigation
// inside the SPA but resets on a full page reload. That matches the
// intent precisely:
//   - cold tab load → flag is false → auto-redirect fires once
//   - any subsequent in-app navigation → NavigationWatcher sets the
//     flag, so coming back to / never re-triggers the bounce
//   - hard refresh of / → fresh module instance, flag false again,
//     vendor is bounced again (which is what we want — they just
//     "opened the app" again)
//
// Pure in-memory state on purpose. sessionStorage would survive across
// reloads, which would mean a hard refresh of / never re-triggers the
// vendor convenience-redirect, and that's worse UX than the current
// behaviour for someone who actually wants to be on their dashboard.

let suppressed = false

export function suppressInitialRedirect(): void {
  suppressed = true
}

export function isInitialRedirectSuppressed(): boolean {
  return suppressed
}
