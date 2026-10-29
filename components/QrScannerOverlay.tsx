'use client'

// In-app scanner for queues (Q3). Full screen: the camera on top, the check
// screen below. It scans continuously: a new QR replaces the card, the same
// QR is ignored for 3 s, and after a ✓ the next ticket can be scanned at
// once — no need to go back between tickets.
//
// Library: qr-scanner (MIT; ~5.7 KB gzipped + a 10.5 KB decoder that only
// loads where the browser has no BarcodeDetector, e.g. iPhone Safari),
// imported only when the scanner opens. Reads our /scan/<token> links.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBi } from '@/lib/languageContext'
import ScanResultCard, { type ScanViewClient } from '@/components/ScanResultCard'
import { tokenFromScan } from '@/lib/shortCode'


export default function QrScannerOverlay({ onClose }: { onClose: () => void }) {
  const bi = useBi()
  const video = useRef<HTMLVideoElement>(null)
  const last = useRef<{ token: string; at: number } | null>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [view, setView] = useState<ScanViewClient | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notOurs, setNotOurs] = useState(false)
  const [restaurantId, setRestaurantId] = useState('')

  useEffect(() => {
    let scanner: { start: () => Promise<void>; stop: () => void; destroy: () => void } | null = null
    let cancelled = false
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onDecode = (data: string) => {
      const t = tokenFromScan(data)
      if (!t) { setNotOurs(true); return }
      const now = Date.now()
      if (last.current && last.current.token === t && now - last.current.at < 3000) return
      last.current = { token: t, at: now }
      setNotOurs(false); setDone(false); setRestaurantId(''); setToken(t); setView(null)
      if (navigator.vibrate) navigator.vibrate(60)
      fetch(`/api/scan/${t}`, { cache: 'no-store' })
        .then(r => r.json()).then(d => { if (!cancelled) setView(d as ScanViewClient) })
        .catch(() => { if (!cancelled) setView({ kind: 'reservation', access: 'none', state: 'refused', reason: 'Réseau indisponible / Network unavailable' }) })
    }

    ;(async () => {
      try {
        const QrScanner = (await import('qr-scanner')).default
        if (cancelled || !video.current) return
        scanner = new QrScanner(video.current, r => onDecode(r.data), {
          preferredCamera: 'environment', maxScansPerSecond: 6, highlightScanRegion: true, returnDetailedScanResult: true,
        })
        await scanner.start()
      } catch (e) {
        const name = (e as { name?: string })?.name ?? String(e)
        setCamError(/NotAllowed|Permission|denied/i.test(name)
          ? 'denied'
          : /NotFound|no camera/i.test(name) ? 'nocam' : 'other')
      }
    })()
    return () => {
      cancelled = true
      document.body.style.overflow = prev
      try { scanner?.stop(); scanner?.destroy() } catch { /* already gone */ }
    }
  }, [])

  async function redeem() {
    if (!token) return
    setBusy(true)
    const r = await fetch(`/api/scan/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ via: 'scan', restaurant_id: restaurantId || undefined }),
    }).catch(() => null)
    const d = r ? await r.json().catch(() => null) : null
    setBusy(false)
    if (d) setView(d as ScanViewClient)
    setDone(!!r?.ok)
    if (r?.ok && navigator.vibrate) navigator.vibrate([40, 60, 40])
  }

  const camMessage = camError === 'denied'
    ? bi('Accès à l\'appareil photo refusé. Autorisez-le dans les réglages du navigateur (icône 🔒 ou « aA » près de l\'adresse), puis rouvrez le scanner.',
      'Camera access denied. Allow it in the browser settings (🔒 or "aA" icon next to the address), then reopen the scanner.')
    : camError === 'nocam'
      ? bi('Aucun appareil photo trouvé sur cet appareil.', 'No camera found on this device.')
      : camError
        ? bi('Impossible d\'ouvrir l\'appareil photo. Utilisez le code à la place.', 'Could not open the camera. Use the code instead.')
        : null

  return createPortal(
    <div className="fixed inset-0 z-[80] bg-black flex flex-col" role="dialog" aria-modal="true" aria-label={bi('Scanner', 'Scanner')}>
      <div className="flex items-center justify-between px-4 h-14 text-white flex-shrink-0">
        <span className="font-semibold">📷 {bi('Scanner — scannez les QR à la suite', 'Scanner — scan QRs one after another')}</span>
        <button type="button" onClick={onClose} aria-label={bi('Fermer', 'Close')} className="w-10 h-10 rounded-full bg-white/15 text-xl">✕</button>
      </div>
      <div className="relative flex-shrink-0 h-[42vh] bg-black overflow-hidden">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={video} className="w-full h-full object-cover" playsInline muted />
        {camMessage && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-white text-sm bg-black/80">{camMessage}</div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto bg-surface rounded-t-3xl -mt-4 relative p-5">
        {notOurs && !view && (
          <p className="text-center text-sm text-danger font-semibold">✕ {bi('Ce QR n\'est pas un billet Tchop & Ndjoka.', 'This QR is not a Tchop & Ndjoka ticket.')}</p>
        )}
        {!view && !notOurs && (
          <p className="text-center text-ink-tertiary mt-4">{token ? bi('Vérification…', 'Checking…') : bi('Pointez la caméra vers le QR du client.', 'Point the camera at the customer\'s QR.')}</p>
        )}
        {view && (
          <ScanResultCard view={view} done={done} busy={busy} onRedeem={redeem}
            restaurantId={restaurantId} onRestaurant={setRestaurantId} />
        )}
        {view && (done || view.state !== 'ready' || view.access !== 'staff') && (
          <p className="mt-4 text-center text-xs text-ink-tertiary">{bi('Prêt : scannez le QR suivant.', 'Ready: scan the next QR.')}</p>
        )}
      </div>
    </div>,
    document.body,
  )
}
