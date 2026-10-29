'use client'

// Mode gate (Client / Pro separated). A page that belongs to one mode,
// opened in the other (a WhatsApp link, a bookmark, "+ Ajouter", ☰ Espace
// Pro), shows a small screen instead of silently switching:
//   "Cette page fait partie du mode Pro." [Passer en mode Pro] [Retour]
// The button switches and STAYS on the page (a door-staff link opens the
// scanner, not the Pro home). Logged out on a Pro page → login first, then
// the same screen. Admins: unchanged (no gate).

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'
import { useSwitchMode } from '@/lib/useSwitchMode'
import { pageMode } from '@/lib/modeSurfaces'
import { loginHref } from '@/lib/lastPhone'
import { isAdminRole } from '@/lib/adminNav'

export default function ModeGate({ children }: { children: React.ReactNode }) {
  const bi = useBi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const { loading, sessionRole, canEnterPro, effectiveMode } = useMode()
  const switchMode = useSwitchMode()
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

  const pro = need === 'pro'
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-6">
      <div className="max-w-sm w-full bg-white rounded-3xl shadow-sm p-6 text-center">
        <p className="text-5xl" aria-hidden="true">{pro ? '🧰' : '🛍️'}</p>
        <h1 className="mt-3 text-lg font-bold text-ink-primary">
          {pro ? bi('Cette page fait partie du mode Pro.', 'This page is part of Pro mode.') : bi('Cette page fait partie du mode Client.', 'This page is part of Client mode.')}
        </h1>
        <p className="mt-1 text-sm text-ink-secondary">
          {pro ? bi('Vous êtes en mode Client.', 'You are in Client mode.') : bi('Vous êtes en mode Pro.', 'You are in Pro mode.')}
        </p>
        <button type="button" onClick={() => switchMode(need)}
          className="mt-5 w-full bg-brand hover:bg-brand-dark text-white py-3 rounded-xl font-bold">
          {pro ? bi('Passer en mode Pro', 'Switch to Pro mode') : bi('Passer en mode Client', 'Switch to Client mode')}
        </button>
        <button type="button" onClick={() => (window.history.length > 1 ? router.back() : router.push('/'))}
          className="mt-2 w-full border border-divider py-3 rounded-xl font-semibold text-ink-secondary hover:bg-surface-muted">
          {bi('Retour', 'Back')}
        </button>
      </div>
    </div>
  )
}
