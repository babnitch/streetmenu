import type { Metadata } from 'next'
import './globals.css'
import { CartProvider } from '@/lib/cartContext'
import { LanguageProvider } from '@/lib/languageContext'
import { AuthProvider } from '@/lib/authContext'
import { CityProvider } from '@/lib/cityContext'
import { ModeProvider } from '@/lib/modeContext'
import { CLIENT_VERSION } from '@/lib/clientVersion'
import BottomNav from '@/components/BottomNav'

export const metadata: Metadata = {
  title: 'Tchop & Ndjoka',
  description: 'Découvrez les meilleurs restaurants et événements food près de chez vous',
}

// Build-time stamp baked into the HTML. Computed once at module-load
// (i.e. during the build), so every page from a given deploy carries
// the same value. The version meta + this stamp together let support
// triangulate "which build is this user on?" without console access.
const BUILD_STAMP = String(Date.now())

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <head>
        <meta name="version" content={CLIENT_VERSION} />
        <meta name="build" content={BUILD_STAMP} />
      </head>
      <body className="antialiased pb-16 md:pb-0">
        {/* pb-16 on mobile reserves room for the fixed bottom nav so
            content isn't hidden under it; desktop (md+) removes the pad
            since BottomNav is hidden there. */}
        <LanguageProvider>
          <AuthProvider>
            <CartProvider>
              <CityProvider>
                <ModeProvider>
                  {children}
                  <BottomNav />
                </ModeProvider>
              </CityProvider>
            </CartProvider>
          </AuthProvider>
        </LanguageProvider>
      </body>
    </html>
  )
}
