'use client'

// "Demander l'activation" (M5): asks the admin to switch a module on. One
// pending request per module — a second tap just says it was already sent.

import { useState } from 'react'
import { useBi } from '@/lib/languageContext'
import type { ModuleSubject } from '@/lib/modules'

export default function RequestModuleButton({
  subject, module, restaurantId, pending = false, onSent,
}: {
  subject: ModuleSubject
  module: string
  restaurantId?: string
  pending?: boolean
  onSent?: () => void
}) {
  const bi = useBi()
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>(pending ? 'sent' : 'idle')
  const [error, setError] = useState('')

  async function ask() {
    setState('sending')
    setError('')
    try {
      const res = await fetch('/api/pro/modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, module, restaurant_id: restaurantId }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setState('error'); setError(d.error ?? bi('Erreur', 'Error')); return }
      setState('sent')
      onSent?.()
    } catch {
      setState('error')
      setError(bi('Erreur réseau', 'Network error'))
    }
  }

  if (state === 'sent') {
    return <span className="inline-block text-xs font-semibold text-amber-700 bg-amber-50 px-3 py-1.5 rounded-full">⏳ {bi('Demande envoyée', 'Request sent')}</span>
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button onClick={ask} disabled={state === 'sending'}
        className="text-xs font-semibold bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white px-3 py-1.5 rounded-full transition-colors">
        {state === 'sending' ? '…' : bi('Demander l\'activation', 'Request activation')}
      </button>
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </span>
  )
}
