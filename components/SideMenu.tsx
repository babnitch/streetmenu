'use client'

// The ☰ menu (L3; N1; Client / Pro separated). Its rows come from
// lib/modeSurfaces sideMenuItems(mode):
//   logged out  Créer un compte · Se connecter · Espace Pro (login first)
//   Client      Mes commandes · Mes réservations · Mes favoris · Espace Pro
//               (→ the "Passer en mode Pro" screen)
//   Pro         Commandes du restaurant · Mes événements · Contrôle à
//               l'entrée · Mes livraisons · Ajouter mon restaurant ou bar ·
//               Ajouter un événement ou un lieu
//   always      Mode économique · FR | EN · Se déconnecter

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'
import { proLoginHref } from '@/lib/lastPhone'
import { sideMenuItems } from '@/lib/modeSurfaces'
import { useDataMode } from '@/lib/dataMode'
import LanguageToggle from './LanguageToggle'
import { openAddSheet } from './AddSheet'

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
  const { hasRestaurantRole, setDashboardTab, resetMode, effectiveMode } = useMode()
  const { isLowData, toggle: toggleLowData } = useDataMode()
  // Q4: door staff (or organisers) with an event to check get an entry.
  const [checkEvents, setCheckEvents] = useState(0)
  // Q5: riders get "Mes livraisons".
  const [isRider, setIsRider] = useState(false)
  useEffect(() => {
    if (!open || !user || effectiveMode !== 'pro') return
    fetch('/api/scan/my-events', { cache: 'no-store' }).then(r => r.json())
      .then(d => setCheckEvents(Array.isArray(d?.events) ? d.events.length : 0)).catch(() => null)
    fetch('/api/rider/orders', { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      .then(d => setIsRider(d?.rider === true)).catch(() => null)
  }, [open, user, effectiveMode])
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
  const items = sideMenuItems(effectiveMode, loggedIn, {
    hasRestaurant: hasRestaurantRole, isOwner: false, checksEvents: checkEvents > 0, isRider, canPromote: false, canBroadcast: false,
  })

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

  // Portalled to <body>: inside the sticky header (its own stacking
  // context) the bottom bar covered the menu's last rows.
  return createPortal(
    <div className="fixed inset-0 z-[55]" role="dialog" aria-modal="true" aria-label={bi('Menu', 'Menu')}>
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
          {/* Client / Pro separated (lib/modeSurfaces sideMenuItems): each
              mode lists only its own rows. Plain links (full load) for the
              /account?tab= ones: /account reads ?tab= when it loads. */}
          {items.map(item => {
            switch (item) {
              case 'myOrders': return <PlainItem key={item} href="/account?tab=orders" icon="🧾">{bi('Mes commandes', 'My orders')}</PlainItem>
              case 'myBookings': return <PlainItem key={item} href="/account?tab=bookings" icon="🎟">{bi('Mes réservations', 'My bookings')}</PlainItem>
              case 'myFavorites': return <PlainItem key={item} href="/account?tab=favorites" icon="♥">{bi('Mes favoris', 'My favourites')}</PlainItem>
              // Client → the Pro switch screen (ModeGate on /pro); logged out → login first.
              case 'proSpace': return <Item key={item} href={loggedIn ? '/pro' : proLoginHref('/pro')} onClick={onClose} icon="🧰">{bi('Espace Pro', 'Pro space')}</Item>
              case 'restaurantOrders': return (
                <button key={item} type="button" onClick={restaurantOrders}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-ink-primary hover:bg-surface-muted text-left">
                  <span aria-hidden="true" className="w-6 text-center">📦</span>
                  <span className="flex-1">{bi('Commandes du restaurant', 'Restaurant orders')}</span>
                  {pendingCount > 0 && (
                    <span className="min-w-5 h-5 px-1.5 rounded-full bg-brand text-white text-[10px] font-bold flex items-center justify-center">
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </span>
                  )}
                </button>
              )
              case 'proHelp': return <Item key={item} href="/pro/aide" onClick={onClose} icon="❓">{bi('Aide Pro', 'Pro help')}</Item>
              case 'myEvents': return <Item key={item} href="/pro/events" onClick={onClose} icon="🎉">{bi('Mes événements', 'My events')}</Item>
              case 'doorCheck': return <Item key={item} href="/scanner" onClick={onClose} icon="🚪">{bi("Contrôle à l'entrée", 'Door check')}</Item>
              case 'deliveries': return <Item key={item} href="/livraisons" onClick={onClose} icon="🛵">{bi('Mes livraisons', 'My deliveries')}</Item>
              case 'addRestaurant': return <Item key={item} href="/pro/restaurants/new" onClick={onClose} icon="🏪">{bi('Ajouter mon restaurant ou bar', 'Add my restaurant or bar')}</Item>
              case 'addEventOrPlace': return (
                <button key={item} type="button" onClick={() => { onClose(); openAddSheet() }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-ink-primary hover:bg-surface-muted text-left">
                  <span aria-hidden="true" className="w-6 text-center">📢</span>{bi('Ajouter un événement ou un lieu', 'Add an event or a place')}
                </button>
              )
              default: return null   // header / footer rows: signup, login, account, lowData, language, signOut
            }
          })}
        </nav>

        <label className="border-t border-divider flex items-center gap-3 px-4 py-3 text-sm text-ink-primary cursor-pointer flex-shrink-0">
          <span aria-hidden="true" className="w-6 text-center">📶</span>
          <span className="flex-1">
            <span className="block">{bi('Mode économique', 'Low data mode')}</span>
            <span className="block text-[11px] text-ink-tertiary">{bi('Économise ~90% de données', 'Saves ~90% of data')}</span>
          </span>
          <input type="checkbox" role="switch" checked={isLowData} onChange={toggleLowData} className="w-5 h-5 accent-brand" />
        </label>

        <div className="border-t border-divider px-4 py-3 flex items-center justify-between gap-3 flex-shrink-0">
          <LanguageToggle />
          {loggedIn && (
            <button type="button" onClick={signOut} className="text-sm font-semibold text-danger hover:underline">
              {bi('Se déconnecter', 'Log out')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
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
