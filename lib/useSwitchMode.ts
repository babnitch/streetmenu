'use client'

// The only way the app mode changes (besides sign-out): ModeToggle and the
// ModeGate "Passer en mode Pro / Client" button. Saved on the account too,
// so the next login (any device) opens in it.

import { useCallback } from 'react'
import { useMode, type Mode } from '@/lib/modeContext'

export function useSwitchMode(): (next: Mode) => void {
  const { setMode } = useMode()
  return useCallback((next: Mode) => {
    setMode(next)
    fetch('/api/customer/mode', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next }),
    }).catch(() => { /* the browser keeps the choice either way */ })
  }, [setMode])
}
