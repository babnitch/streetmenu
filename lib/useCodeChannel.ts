'use client'

import { useEffect } from 'react'

// After a login code was sent on WhatsApp, asks every 3 s for 45 s whether
// it went out by SMS instead (Twilio reported WhatsApp couldn't deliver —
// lib/smsFallback.ts) and tells the page, which then says "Code envoyé par
// SMS". Stops on the first SMS answer.
export function useCodeChannel(ticket: string | null, watching: boolean, onSms: () => void): void {
  useEffect(() => {
    if (!ticket || !watching) return
    let stopped = false
    const started = Date.now()
    const tick = async () => {
      if (stopped || Date.now() - started > 45_000) return
      try {
        const r = await fetch(`/api/auth/code-channel?ticket=${encodeURIComponent(ticket)}`, { cache: 'no-store' })
        const d = await r.json()
        if (!stopped && d?.channel === 'sms') { onSms(); return }
      } catch { /* try again */ }
      if (!stopped) timer = setTimeout(tick, 3000)
    }
    let timer = setTimeout(tick, 3000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [ticket, watching, onSms])
}
