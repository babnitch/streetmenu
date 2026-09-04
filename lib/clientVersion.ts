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
// Per-tab marker so a version-guard reload can never happen twice in the
// same tab, whatever storage does underneath. Deliberately NOT tn_-prefixed
// so the version sweep can't clear it mid-flight.
const RELOAD_ONCE_KEY = 'sm_version_reloaded'

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
//
// The reload is the dangerous part, so it is gated three ways: the new
// version must read back from storage, a per-tab sessionStorage marker
// must be armable, and that marker must not already be set. Fail any of
// them and we return without reloading — a stale-storage visitor gets
// defaults, never a loop.
export function runClientVersionGuard(): void {
  if (guardRan) return
  guardRan = true
  if (typeof window === 'undefined') return
  try {
    const stored = window.localStorage.getItem(VERSION_KEY)
    if (stored === CLIENT_VERSION) return

    // Write the new version FIRST. VERSION_KEY is itself tn_-prefixed, so
    // the sweep below would otherwise delete it and leave the guard
    // depending on a later re-write landing — one reorder away from a
    // permanent reload loop.
    window.localStorage.setItem(VERSION_KEY, CLIENT_VERSION)

    const toClear: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && k !== VERSION_KEY && (k.startsWith('tn_') || k.startsWith('nt_'))) toClear.push(k)
    }
    for (const k of toClear) window.localStorage.removeItem(k)

    // First-time visitors had nothing stale to clear, so a reload would
    // just be UX noise.
    if (stored === null) return

    // A reload is only safe once we KNOW the new version survived the
    // write. Safari ITP eviction, partitioned/ephemeral storage and
    // policy-restricted site data can all accept a setItem that does not
    // persist — in which case the next load reads the old value, clears,
    // writes, reloads… forever, and no page ever finishes mounting.
    // Verify, and when it didn't stick, carry on with cleared storage and
    // defaults instead. Degraded beats looping.
    if (window.localStorage.getItem(VERSION_KEY) !== CLIENT_VERSION) return

    // Circuit breaker. Even if the read-back lies, a tab reloads at most
    // once: sessionStorage is per-tab and survives a reload, so the second
    // pass through here bails. Wrapped separately because sessionStorage
    // can be unavailable while localStorage works — if we can't arm the
    // breaker, we don't take the risk.
    try {
      if (window.sessionStorage.getItem(RELOAD_ONCE_KEY)) return
      window.sessionStorage.setItem(RELOAD_ONCE_KEY, '1')
    } catch {
      return
    }

    window.location.reload()
  } catch {
    /* private mode / Safari ITP / disabled storage — nothing to do */
  }
}
