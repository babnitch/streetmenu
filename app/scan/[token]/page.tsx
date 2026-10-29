'use client'

// /scan/<token> (Q2) — what a QR opens, on any phone camera. Opening it
// never changes anything; only the button does (POST).
// Validating is a Pro action: someone allowed to validate but in Client
// mode sees the "Passer en mode Pro" screen first, then this same page with
// the button (the server refuses a Client-mode validation too). The owner
// sees their own item in either mode; anyone else the neutral page.

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import TopNav from '@/components/TopNav'
import ScanResultCard, { type ScanViewClient } from '@/components/ScanResultCard'
import ModeSwitchScreen from '@/components/ModeSwitchScreen'
import { useMode } from '@/lib/modeContext'
import { isAdminRole } from '@/lib/adminNav'
import { useBi } from '@/lib/languageContext'
import { loginHref } from '@/lib/lastPhone'

export default function ScanPage() {
  const bi = useBi()
  const { token } = useParams<{ token: string }>()
  const [view, setView] = useState<ScanViewClient | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restaurantId, setRestaurantId] = useState('')
  const [url, setUrl] = useState('')
  const { effectiveMode, sessionRole } = useMode()
  // The server said "Client mode" (the account's saved mode) — ask to switch.
  const [serverWantsPro, setServerWantsPro] = useState(false)

  useEffect(() => {
    setUrl(window.location.href)
    fetch(`/api/scan/${token}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => setView(d as ScanViewClient))
      .catch(() => setView({ kind: 'reservation', access: 'none', state: 'refused', reason: 'Réseau indisponible / Network unavailable' }))
  }, [token])

  async function redeem() {
    setBusy(true)
    const r = await fetch(`/api/scan/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ via: 'scan', restaurant_id: restaurantId || undefined }),
    }).catch(() => null)
    const d = r ? await r.json().catch(() => null) : null
    setBusy(false)
    if (d?.reason === 'client_mode') { setServerWantsPro(true); return }
    if (d) setView(d as ScanViewClient)
    setDone(!!r?.ok)
  }

  const needsPro = !!view && view.access === 'staff' && !isAdminRole(sessionRole) && (effectiveMode === 'client' || serverWantsPro)

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-md mx-auto px-4 pt-6 pb-28">
        {!view ? (
          <p className="text-center text-ink-tertiary mt-10">{bi('Vérification…', 'Checking…')}</p>
        ) : needsPro ? (
          <ModeSwitchScreen need="pro" onSwitched={() => setServerWantsPro(false)} />
        ) : (
          <div className="bg-white rounded-3xl shadow-sm p-5">
            <ScanResultCard view={view} done={done} busy={busy} onRedeem={redeem}
              loginHref={loginHref(`/scan/${token}`)} ownQrUrl={url}
              restaurantId={restaurantId} onRestaurant={setRestaurantId} />
          </div>
        )}
      </main>
    </div>
  )
}
