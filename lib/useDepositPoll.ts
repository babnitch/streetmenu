'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type DepositPollPhase = 'idle' | 'waiting' | 'paid' | 'failed' | 'timeout'

interface Options {
  onPaid?:   () => void
  onFailed?: (reason: string | null) => void
}

// Polls /api/payments/status/<depositId> after a MoMo payment is created —
// the same loop as the order and event checkouts (app/order/page.tsx,
// app/events/[id]/page.tsx): one tick right away, then every 3s, stop on a
// terminal phase, give up after 2 min. Polling is also what reconciles the
// row server-side when PawaPay's webhook never arrives.
export function useDepositPoll({ onPaid, onFailed }: Options = {}) {
  const [phase, setPhase] = useState<DepositPollPhase>('idle')
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const depositRef   = useRef<string | null>(null)

  // Latest callbacks without restarting an in-flight poll.
  const onPaidRef   = useRef(onPaid)
  const onFailedRef = useRef(onFailed)
  onPaidRef.current   = onPaid
  onFailedRef.current = onFailed

  const stop = useCallback(() => {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
    if (timeoutRef.current)   { clearTimeout(timeoutRef.current);    timeoutRef.current = null }
  }, [])

  const start = useCallback((depositId: string) => {
    stop()
    depositRef.current = depositId
    setPhase('waiting')
    const tick = async () => {
      try {
        const r = await fetch(`/api/payments/status/${depositId}`, { cache: 'no-store' })
        const d = await r.json()
        // A reset or a newer start() while this fetch was in flight.
        if (depositRef.current !== depositId) return
        if (d.phase === 'paid') {
          stop()
          setPhase('paid')
          onPaidRef.current?.()
        } else if (d.phase === 'failed') {
          stop()
          setPhase('failed')
          onFailedRef.current?.(d.failureReason ?? null)
        }
      } catch { /* transient — keep polling, 2-min timeout below is the failsafe */ }
    }
    tick()
    pollTimerRef.current = setInterval(tick, 3000)
    timeoutRef.current   = setTimeout(() => {
      stop()
      setPhase(prev => prev === 'waiting' ? 'timeout' : prev)
    }, 120_000)
  }, [stop])

  // After a timeout: poll the same deposit again. Each tick also reconciles
  // server-side, so this recovers a payment whose webhook never arrived.
  const retry = useCallback(() => {
    if (depositRef.current) start(depositRef.current)
  }, [start])

  const reset = useCallback(() => { stop(); depositRef.current = null; setPhase('idle') }, [stop])

  // Don't leave a timer hitting PawaPay after the panel unmounts.
  useEffect(() => stop, [stop])

  return { phase, start, retry, reset }
}
