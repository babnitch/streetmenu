'use client'

// The ☰ menu (L3), opened from the header on every page, mobile and desktop.
//
// Logged out:  Créer un compte (primary) · Se connecter
//              EXPLORER       Restaurants · Événements · city
//              PROFESSIONNELS Ajouter mon restaurant · Organiser un événement
//                             (both through the Pro login path, landing on
//                             the right form)
//              Commander sur WhatsApp · FR | EN
// Logged in:   avatar + name · Voir mon compte
//              Restaurants · Événements · Mes commandes · Mes réservations ·
//              Commander sur WhatsApp
//              PROFESSIONNELS Ajouter mon restaurant · Organiser un événement
//                             (+ Commandes du restaurant for a restaurant team)
//                             — the Client/Pro switch stays in Mon compte
//              FR | EN · Se déconnecter
//
// "Commander sur WhatsApp" only shows when NEXT_PUBLIC_WHATSAPP_BOT_NUMBER is
// set (no public bot number yet).

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'
import { useCity, CITIES, type City } from '@/lib/cityContext'
import { proLoginHref } from '@/lib/lastPhone'
import LanguageToggle from './LanguageToggle'

const BOT_NUMBER = (process.env.NEXT_PUBLIC_WHATSAPP_BOT_NUMBER ?? '').replace(/\D/g, '')

export interface SideMenuUser { name: string; role: string }

export default function SideMenu({
  open, onClose, user, pendingCount,
}: {
  open: boolean
  onClose: () => void
  user: SideMenuUser | null
  pendingCount: number
}) {
  const bi = useBi()
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const { hasRestaurantRole, setDashboardTab, resetMode } = useMode()
  const { city, setCity } = useCity()
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on navigation and on Escape; lock the page scroll while open.
  useEffect(() => { onClose() }, [pathname]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open, onClose])

  if (!open) return null

  const loggedIn = !!user
  const addRestaurant = loggedIn ? '/pro/restaurants/new' : proLoginHref('/pro/restaurants/new')
  const organiseEvent = loggedIn ? '/events/submit' : proLoginHref('/events/submit')

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null)
    resetMode()
    window.location.href = '/'
  }

  function restaurantOrders() {
    setDashboardTab('orders')
    router.push('/dashboard')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={bi('Menu', 'Menu')}>
      <button type="button" aria-label={bi('Fermer le menu', 'Close menu')} onClick={onClose}
        className="absolute inset-0 bg-black/40" />
      <div ref={panelRef} tabIndex={-1}
        className="absolute inset-y-0 left-0 w-[85%] max-w-xs bg-surface shadow-xl flex flex-col outline-none overflow-y-auto">
        <div className="flex items-center justify-between px-4 h-14 border-b border-divider flex-shrink-0">
          <span className="font-bold text-ink-primary">Tchop &amp; Ndjoka</span>
          <button type="button" onClick={onClose} aria-label={bi('Fermer', 'Close')}
            className="w-9 h-9 -mr-2 rounded-full flex items-center justify-center text-xl text-ink-secondary hover:bg-surface-muted">✕</button>
        </div>

        <div className="px-4 py-4 border-b border-divider">
          {loggedIn ? (
            <Link href="/account" onClick={onClose} className="flex items-center gap-3">
              <span className="w-11 h-11 rounded-full bg-brand text-white font-bold flex items-center justify-center text-lg" aria-hidden="true">
                {(user!.name || '?').trim().charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold text-ink-primary truncate">{user!.name}</span>
                <span className="block text-xs text-brand-darker">{bi('Voir mon compte', 'View my account')} ›</span>
              </span>
            </Link>
          ) : (
            <div className="space-y-2">
              <Link href="/login" onClick={onClose} className="block w-full text-center bg-brand hover:bg-brand-dark text-white py-2.5 rounded-xl text-sm font-bold">
                {bi('Créer un compte', 'Create an account')}
              </Link>
              <Link href="/login" onClick={onClose} className="block w-full text-center border border-divider text-ink-primary py-2.5 rounded-xl text-sm font-semibold hover:bg-surface-muted">
                {bi('Se connecter', 'Log in')}
              </Link>
            </div>
          )}
        </div>

        <nav className="flex-1 py-2">
          {!loggedIn && <Heading>{bi('Explorer', 'Explore')}</Heading>}
          <Item href="/" onClick={onClose} icon="🍽️">{bi('Restaurants', 'Restaurants')}</Item>
          <Item href="/events" onClick={onClose} icon="🎉">{bi('Événements', 'Events')}</Item>
          {/* Plain links (full load): /account reads ?tab= when it loads, so
              a soft navigation from /account itself would not switch tab. */}
          {loggedIn && <PlainItem href="/account?tab=orders" icon="🧾">{bi('Mes commandes', 'My orders')}</PlainItem>}
          {loggedIn && <PlainItem href="/account?tab=bookings" icon="🎟">{bi('Mes réservations', 'My bookings')}</PlainItem>}
          <label className="flex items-center gap-3 px-4 py-2.5 text-sm text-ink-primary">
            <span aria-hidden="true" className="w-6 text-center">📍</span>
            <span className="flex-1">{bi('Ville', 'City')}</span>
            <select value={city} onChange={e => setCity(e.target.value as City)}
              className="bg-surface-muted border border-divider rounded-lg px-2 py-1 text-sm">
              {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {BOT_NUMBER && (
            <a href={`https://wa.me/${BOT_NUMBER}?text=menu`} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-ink-primary hover:bg-surface-muted">
              <span aria-hidden="true" className="w-6 text-center">💬</span>{bi('Commander sur WhatsApp', 'Order on WhatsApp')}
            </a>
          )}

          <Heading>{bi('Professionnels', 'Professionals')}</Heading>
          {loggedIn && hasRestaurantRole && (
            <button type="button" onClick={restaurantOrders}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-ink-primary hover:bg-surface-muted text-left">
              <span aria-hidden="true" className="w-6 text-center">📦</span>
              <span className="flex-1">{bi('Commandes du restaurant', 'Restaurant orders')}</span>
              {pendingCount > 0 && (
                <span className="min-w-5 h-5 px-1.5 rounded-full bg-brand text-white text-[10px] font-bold flex items-center justify-center">
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
            </button>
          )}
          <Item href={addRestaurant} onClick={onClose} icon="🏪">{bi('Ajouter mon restaurant', 'Add my restaurant')}</Item>
          <Item href={organiseEvent} onClick={onClose} icon="📢">{bi('Organiser un événement', 'Organise an event')}</Item>
          {loggedIn && (
            <p className="px-4 pt-1 pb-2 text-[11px] text-ink-tertiary">
              {bi('Le mode Pro s\'active dans Mon compte.', 'Switch to Pro mode in My account.')}
            </p>
          )}
        </nav>

        <div className="border-t border-divider px-4 py-3 flex items-center justify-between gap-3 flex-shrink-0">
          <LanguageToggle />
          {loggedIn && (
            <button type="button" onClick={signOut} className="text-sm font-semibold text-danger hover:underline">
              {bi('Se déconnecter', 'Log out')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pt-4 pb-1 text-[11px] font-bold uppercase tracking-wide text-ink-tertiary">{children}</p>
}

function Item({ href, icon, children, onClick }: { href: string; icon: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <Link href={href} onClick={onClick} className="flex items-center gap-3 px-4 py-2.5 text-sm text-ink-primary hover:bg-surface-muted">
      <span aria-hidden="true" className="w-6 text-center">{icon}</span>{children}
    </Link>
  )
}

function PlainItem({ href, icon, children }: { href: string; icon: string; children: React.ReactNode }) {
  return (
    <a href={href} className="flex items-center gap-3 px-4 py-2.5 text-sm text-ink-primary hover:bg-surface-muted">
      <span aria-hidden="true" className="w-6 text-center">{icon}</span>{children}
    </a>
  )
}
