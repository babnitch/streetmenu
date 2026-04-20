import type { Metadata } from 'next'
import './globals.css'
import { CartProvider } from '@/lib/cartContext'
import { LanguageProvider } from '@/lib/languageContext'
import { AuthProvider } from '@/lib/authContext'
import { CityProvider } from '@/lib/cityContext'
import BottomNav from '@/components/BottomNav'

export const metadata: Metadata = {
  title: 'Ndjoka & Tchop',
  description: 'Découvrez les meilleurs restaurants et événements food près de chez vous',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="antialiased pb-16 md:pb-0">
        {/* pb-16 on mobile reserves room for the fixed bottom nav so
            content isn't hidden under it; desktop (md+) removes the pad
            since BottomNav is hidden there. */}
        <LanguageProvider>
          <AuthProvider>
            <CartProvider>
              <CityProvider>
                {children}
                <BottomNav />
              </CityProvider>
            </CartProvider>
          </AuthProvider>
        </LanguageProvider>
      </body>
    </html>
  )
}
