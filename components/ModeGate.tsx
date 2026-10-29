'use client'

// Mode gate (Client / Pro separated). A page that belongs to one mode,
// opened in the other (a WhatsApp link, a bookmark, "+ Ajouter", ☰ Espace
// Pro), shows a small screen instead of silently switching:
//   "Cette page fait partie du mode Pro." [Passer en mode Pro] [Retour]
// The button switches and STAYS on the page (a door-staff link opens the
// scanner, not the Pro home). Logged out on a Pro page → login first, then
// the same screen. Admins: unchanged (no gate).

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useMode } from '@/lib/modeContext'
import ModeSwitchScreen from '@/components/ModeSwitchScreen'
import { pageMode } from '@/lib/modeSurfaces'
import { loginHref } from '@/lib/lastPhone'
import { isAdminRole } from '@/lib/adminNav'

export default function ModeGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? ''
  const { loading, sessionRole, canEnterPro, effectiveMode } = useMode()
  const [search, setSearch] = useState('')
  // The query decides for /account?tab=… (read client-side, no Suspense).
  useEffect(() => { setSearch(window.location.search) }, [pathname])
  const need = pageMode(pathname, search)

  const loggedOut = !loading && !sessionRole
  useEffect(() => {
    if (need === 'pro' && loggedOut) {
      window.location.replace(loginHref(pathname + window.location.search))
    }
  }, [need, loggedOut, pathname])

  if (need === 'any' || isAdminRole(sessionRole)) return <>{children}</>
  if (loading || (need === 'pro' && loggedOut)) {
    return <div className="min-h-screen flex items-center justify-center text-ink-tertiary">…</div>
  }
  if (!canEnterPro || effectiveMode === need) return <>{children}</>

  return (
    <div className="min-h-screen bg-surface">
      <ModeSwitchScreen need={need} />
    </div>
  )
}
