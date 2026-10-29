'use client'

// The public legal & contact info (U1), fetched once per page load.

import { useEffect, useState } from 'react'
import type { LegalInfo } from '@/lib/legalInfo'

let pending: Promise<LegalInfo> | null = null

export function usePlatformInfo(): LegalInfo | null {
  const [info, setInfo] = useState<LegalInfo | null>(null)
  useEffect(() => {
    pending ??= fetch('/api/platform/info').then(r => r.ok ? r.json() : {}).catch(() => ({}))
    let live = true
    pending.then(v => { if (live) setInfo(v) })
    return () => { live = false }
  }, [])
  return info
}
