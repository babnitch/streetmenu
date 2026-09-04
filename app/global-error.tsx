'use client'

import { useEffect } from 'react'
import './globals.css'

// Last-resort boundary. This is the only thing that catches a throw in the
// ROOT LAYOUT itself — including any of the six providers it mounts
// (Language, Auth, Cart, City, Mode, DataMode) and BottomNav. app/error.tsx
// renders *inside* that layout, so it cannot cover them.
//
// Because it REPLACES the root layout when it renders, it must supply its
// own <html> and <body>, and import the stylesheet itself — nothing from
// app/layout.tsx is in play here.
//
// Next.js only mounts this in production builds; in dev the error overlay
// takes precedence.
//
// Same three constraints as app/error.tsx, and they bind harder here: no
// context (the providers are gone), no storage, no fetching. Inline styles
// back up the Tailwind classes so the screen is still readable if the
// stylesheet is what failed to load.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[global error boundary]', error?.digest ?? '(no digest)', error)
  }, [error])

  return (
    <html lang="fr">
      <body>
        <div
          className="min-h-screen bg-surface flex flex-col items-center justify-center px-4 text-center"
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 1rem',
            textAlign: 'center',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ fontSize: '2.5rem', marginBottom: '1.25rem' }}>😕</div>

          <h1
            className="text-xl font-bold text-ink-primary mb-2"
            style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.5rem' }}
          >
            Une erreur est survenue
          </h1>
          <p
            className="text-base font-semibold text-ink-secondary mb-4"
            style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 1rem', opacity: 0.8 }}
          >
            Something went wrong
          </p>

          <p
            className="text-ink-secondary text-sm mb-1"
            style={{ fontSize: '0.875rem', margin: '0 0 0.25rem', maxWidth: '20rem', opacity: 0.8 }}
          >
            L’application n’a pas pu démarrer. Réessayez.
          </p>
          <p
            className="text-ink-tertiary text-sm mb-6"
            style={{ fontSize: '0.875rem', margin: '0 0 1.5rem', maxWidth: '20rem', opacity: 0.6 }}
          >
            The app couldn’t start. Please try again.
          </p>

          <button
            onClick={reset}
            className="bg-brand hover:bg-brand-dark text-white px-6 py-3 rounded-full font-semibold text-sm transition-colors"
            style={{
              background: '#F97316',
              color: '#fff',
              border: 'none',
              padding: '0.75rem 1.5rem',
              borderRadius: '9999px',
              fontWeight: 600,
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Recharger / Reload
          </button>

          {error?.digest && (
            <p
              className="mt-6 text-[11px] text-ink-tertiary"
              style={{ marginTop: '1.5rem', fontSize: '11px', opacity: 0.5, fontFamily: 'monospace' }}
            >
              {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  )
}
