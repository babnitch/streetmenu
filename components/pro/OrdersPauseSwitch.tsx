'use client'

// "Commandes en ligne : ouvertes / en pause" — top of the Orders tab.
// Owner / manager / admin can pause (30 min, 1 h, until tonight's closing,
// until turned back on) and resume; staff only see the state. The
// restaurant stays open; only new online orders stop (lib/ordersPause.ts).
// Hidden until the database has the pause columns (available = false).

import { useCallback, useEffect, useState } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { PAUSE_CHOICES, pauseChoiceLabel, formatPauseEnd, type PauseChoice } from '@/lib/ordersPause'

interface PauseState { available: boolean; paused: boolean; until: string | null }

export default function OrdersPauseSwitch({ restaurantId, timezone, canChange }: {
  restaurantId: string
  timezone: string | null | undefined
  canChange: boolean
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const lang = locale === 'en' ? 'en' : 'fr'
  const [state, setState] = useState<PauseState | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const r = await fetch(`/api/restaurants/${restaurantId}/orders-pause`, { cache: 'no-store' }).then(x => x.ok ? x.json() : null).catch(() => null)
    if (r) setState({ available: !!r.available, paused: !!r.paused, until: r.until ?? null })
  }, [restaurantId])

  useEffect(() => { void load() }, [load])

  // A timed pause ends by itself: refresh just after the end time.
  useEffect(() => {
    if (!state?.paused || !state.until) return
    const ms = new Date(state.until).getTime() - Date.now() + 2000
    const t = setTimeout(() => { void load() }, Math.max(2000, Math.min(ms, 2 ** 31 - 1)))
    return () => clearTimeout(t)
  }, [state, load])

  async function send(body: { pause: PauseChoice } | { resume: true }) {
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/orders-pause`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? bi('Erreur', 'Error')); return }
      setState({ available: true, paused: !!d.paused, until: d.until ?? null })
      setChoosing(false)
    } finally {
      setBusy(false)
    }
  }

  if (!state?.available) return null
  const end = formatPauseEnd(state.until, timezone)

  return (
    <div className={`rounded-2xl border px-4 py-3 mb-3 ${state.paused ? 'bg-amber-50 border-amber-200' : 'bg-white border-divider shadow-sm'}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink-primary">
            {bi('Commandes en ligne', 'Online orders')} :{' '}
            <span className={state.paused ? 'text-amber-700' : 'text-emerald-700'}>
              {state.paused ? `⏸️ ${bi('en pause', 'paused')}` : `🟢 ${bi('ouvertes', 'open')}`}
            </span>
          </p>
          {state.paused && (
            <p className="text-xs text-amber-800 mt-0.5">
              {end
                ? bi(`Reprise automatique à ${end}.`, `Back on automatically at ${end}.`)
                : bi('Jusqu\'à ce que vous réactiviez.', 'Until you turn it back on.')}
              {' '}{bi('Le restaurant reste ouvert.', 'The restaurant stays open.')}
            </p>
          )}
        </div>
        {canChange && (state.paused ? (
          <button type="button" disabled={busy} onClick={() => send({ resume: true })}
            className="flex-shrink-0 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-4 py-2 rounded-full text-sm font-semibold">
            {busy ? '…' : bi('Reprendre', 'Resume')}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => setChoosing(c => !c)} aria-expanded={choosing}
            className="flex-shrink-0 bg-surface-muted hover:bg-divider disabled:opacity-50 text-ink-primary px-4 py-2 rounded-full text-sm font-semibold">
            ⏸️ {bi('Mettre en pause', 'Pause')}
          </button>
        ))}
      </div>
      {canChange && choosing && !state.paused && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {PAUSE_CHOICES.map(c => (
            <button key={c} type="button" disabled={busy} onClick={() => send({ pause: c })}
              className="bg-surface-muted hover:bg-divider disabled:opacity-50 text-ink-primary px-3 py-2 rounded-xl text-sm font-semibold text-left">
              {pauseChoiceLabel(c, lang)}
            </button>
          ))}
        </div>
      )}
      {!state.paused && (
        <p className="text-xs text-ink-tertiary mt-1">
          {bi('En pause, le menu reste visible mais personne ne peut commander en ligne. Les commandes déjà passées continuent.',
              'While paused, the menu stays visible but nobody can order online. Orders already placed carry on.')}
        </p>
      )}
      {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
    </div>
  )
}
