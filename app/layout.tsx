import type { Metadata } from 'next'
import './globals.css'
import { CartProvider } from '@/lib/cartContext'

export const metadata: Metadata = {
  title: 'StreetMenu — Discover Local Food',
  description: 'Find the best street food and local restaurants near you',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <CartProvider>
          {children}
        </CartProvider>
      </body>
    </html>
  )
}
