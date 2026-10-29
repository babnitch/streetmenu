'use client'

// "Cette page fait partie du mode Pro / Client" + [Passer en mode …]
// [Retour] (Client / Pro separated). Used by ModeGate (Pro pages, client
// account tabs) and by /scan/<token> when the viewer may validate but is in
// Client mode. The button switches (saved on the account, which the server
// checks) and the caller stays on the same page.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useBi } from '@/lib/languageContext'
import { useSwitchMode } from '@/lib/useSwitchMode'

export default function ModeSwitchScreen({ need, onSwitched }: { need: 'pro' | 'client'; onSwitched?: () => void }) {
  const bi = useBi()
  const router = useRouter()
  const switchMode = useSwitchMode()
  const [busy, setBusy] = useState(false)
  const pro = need === 'pro'
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-6">
      <div className="max-w-sm w-full bg-white rounded-3xl shadow-sm p-6 text-center">
        <p className="text-5xl" aria-hidden="true">{pro ? '🧰' : '🛍️'}</p>
        <h1 className="mt-3 text-lg font-bold text-ink-primary">
          {pro ? bi('Cette page fait partie du mode Pro.', 'This page is part of Pro mode.') : bi('Cette page fait partie du mode Client.', 'This page is part of Client mode.')}
        </h1>
        <p className="mt-1 text-sm text-ink-secondary">
          {pro ? bi('Vous êtes en mode Client.', 'You are in Client mode.') : bi('Vous êtes en mode Pro.', 'You are in Pro mode.')}
        </p>
        <button type="button" disabled={busy}
          onClick={async () => { setBusy(true); await switchMode(need); setBusy(false); onSwitched?.() }}
          className="mt-5 w-full bg-brand hover:bg-brand-dark disabled:opacity-60 text-white py-3 rounded-xl font-bold">
          {busy ? '…' : pro ? bi('Passer en mode Pro', 'Switch to Pro mode') : bi('Passer en mode Client', 'Switch to Client mode')}
        </button>
        <button type="button" onClick={() => (window.history.length > 1 ? router.back() : router.push('/'))}
          className="mt-2 w-full border border-divider py-3 rounded-xl font-semibold text-ink-secondary hover:bg-surface-muted">
          {bi('Retour', 'Back')}
        </button>
      </div>
    </div>
  )
}
