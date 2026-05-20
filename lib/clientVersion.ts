// Bumping CLIENT_VERSION invalidates every piece of client-side storage
// from a prior release. Use it whenever a deploy renames keys, changes
// the shape of stored values, or otherwise needs a clean slate.
//
// The check runs once per page load via runClientVersionGuard() — the
// first context to mount triggers it, subsequent callers see the version
// already match and return immediately.
//
// Bump rules:
//   - Format: vMAJOR.MINOR. Bump MAJOR for renames/breaking changes.
//   - On bump, optionally add a one-line note here so future debugging
//     can correlate a bump with the change that motivated it.
//
// History:
//   v4.1 — rebrand Ndjoka & Tchop → Tchop & Ndjoka; rename nt_* keys to tn_*

export const CLIENT_VERSION = 'v4.1'
const VERSION_KEY = 'tn_version'

// Module-level so concurrent context mounts only do the work once. Resets
// per page load — exactly what we want.
let guardRan = false

// Idempotent. Clears every tn_* AND nt_* localStorage key when the stored
// version doesn't match the current one, sets the new version, then
// reloads so anything that already read from storage gets a fresh start.
//
// First-visit guard: when nothing was stored before, we silently set the
// version and SKIP the reload. Reloading a brand-new visitor would just
// add a noticeable flash for no benefit.
export function runClientVersionGuard(): void {
  if (guardRan) return
  guardRan = true
  if (typeof window === 'undefined') return
  try {
    const stored = window.localStorage.getItem(VERSION_KEY)
    if (stored === CLIENT_VERSION) return

    const toClear: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && (k.startsWith('tn_') || k.startsWith('nt_'))) toClear.push(k)
    }
    for (const k of toClear) window.localStorage.removeItem(k)

    window.localStorage.setItem(VERSION_KEY, CLIENT_VERSION)

    // Only reload returning visitors — first-time visitors had nothing
    // stale to clear, so a reload would just be UX noise.
    if (stored !== null) {
      window.location.reload()
    }
  } catch {
    /* private mode / Safari ITP / disabled storage — nothing to do */
  }
}
