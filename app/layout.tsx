import type { Metadata } from 'next'
import './globals.css'
import { CartProvider } from '@/lib/cartContext'
import { LanguageProvider } from '@/lib/languageContext'
import { AuthProvider } from '@/lib/authContext'

export const metadata: Metadata = {
  title: 'Ndjoka & Tchop',
  description: 'Découvrez les meilleurs restaurants et événements food près de chez vous',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="antialiased">
        <LanguageProvider>
          <AuthProvider>
            <CartProvider>
              {children}
            </CartProvider>
          </AuthProvider>
        </LanguageProvider>
      </body>
    </html>
  )
}
