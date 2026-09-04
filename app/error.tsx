'use client'

import { useEffect } from 'react'

// Route-level error boundary. Catches render throws anywhere in the page
// tree BELOW the root layout — it renders inside app/layout.tsx, so the
// providers and BottomNav around it stay mounted.
//
// Errors thrown by the root layout itself (or by a provider in it) escape
// this boundary; app/global-error.tsx is the net for those.
//
// Three deliberate constraints on everything below, because a fallback that
// can itself throw is worse than no fallback:
//   1. No context hooks. If a provider is what threw, reading from it here
//      throws again and we bounce straight to global-error.
//   2. No localStorage/sessionStorage. Blocked site data is exactly the
//      class of failure this screen exists to report.
//   3. No data fetching. Static markup plus one button.
//
// Both languages are shown stacked rather than selected, since picking one
// would mean reading LanguageProvider — see constraint 1.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // digest is the only stable identifier a user can read back to us from
    // a production build, where the message itself is minified.
    console.error('[error boundary]', error?.digest ?? '(no digest)', error)
  }, [error])

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-4 text-center">
      <div className="w-20 h-20 bg-surface-muted rounded-full flex items-center justify-center text-4xl mb-5">
        😕
      </div>

      <h1 className="text-xl font-bold text-ink-primary mb-2">
        Une erreur est survenue
      </h1>
      <p className="text-base font-semibold text-ink-secondary mb-4">
        Something went wrong
      </p>

      <p className="text-ink-secondary text-sm mb-1 max-w-xs">
        Cette page n’a pas pu s’afficher. Réessayez.
      </p>
      <p className="text-ink-tertiary text-sm mb-6 max-w-xs">
        This page couldn’t be displayed. Please try again.
      </p>

      <button
        onClick={reset}
        className="bg-brand hover:bg-brand-dark text-white px-6 py-3 rounded-full font-semibold text-sm transition-colors"
      >
        Recharger / Reload
      </button>

      {error?.digest && (
        <p className="mt-6 text-[11px] text-ink-tertiary font-mono">
          {error.digest}
        </p>
      )}
    </div>
  )
}
