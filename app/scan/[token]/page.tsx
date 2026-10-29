'use client'

// /scan/<token> (Q2) — what a QR opens, on any phone camera. Opening it
// never changes anything; only the button does (POST).

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import TopNav from '@/components/TopNav'
import ScanResultCard, { type ScanViewClient } from '@/components/ScanResultCard'
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
    if (d) setView(d as ScanViewClient)
    setDone(!!r?.ok)
  }

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-md mx-auto px-4 pt-6 pb-28">
        {!view ? (
          <p className="text-center text-ink-tertiary mt-10">{bi('Vérification…', 'Checking…')}</p>
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
