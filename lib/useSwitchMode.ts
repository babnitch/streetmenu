'use client'

// The only way the app mode changes (besides sign-out): ModeToggle and the
// ModeGate "Passer en mode Pro / Client" button. Saved on the account too,
// so the next login (any device) opens in it.

import { useCallback } from 'react'
import { useMode, type Mode } from '@/lib/modeContext'

// Resolves once the account has saved it (the server checks the saved mode
// for Pro actions, e.g. validating a QR), true when saved.
export function useSwitchMode(): (next: Mode) => Promise<boolean> {
  const { setMode } = useMode()
  return useCallback(async (next: Mode) => {
    setMode(next)
    try {
      const r = await fetch('/api/customer/mode', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next }),
      })
      return r.ok
    } catch { return false /* the browser keeps the choice either way */ }
  }, [setMode])
}
