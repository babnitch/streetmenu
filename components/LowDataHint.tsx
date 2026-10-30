'use client'

// First visit only (no choice stored): one small line under the header —
// "Données limitées ? Activez le Mode économique" with a switch. ✕ or the
// switch stores the choice, so it does not come back.

import { useBi } from '@/lib/languageContext'
import { useDataMode } from '@/lib/dataMode'

export default function LowDataHint() {
  const bi = useBi()
  const { hasChoice, isLowData, setLowData } = useDataMode()
  if (hasChoice) return null
  return (
    <div className="border-t border-divider bg-emerald-50/70">
      <div className="max-w-6xl mx-auto px-4 py-1.5 flex items-center gap-3 text-xs text-emerald-900">
        <span aria-hidden="true">📶</span>
        <label className="flex-1 flex items-center justify-between gap-3 cursor-pointer">
          <span>{bi('Données limitées ? Activez le Mode économique', 'Limited data? Turn on Low-data mode')}</span>
          <input type="checkbox" role="switch" checked={isLowData} onChange={e => setLowData(e.target.checked)} className="w-4 h-4 accent-emerald-700" />
        </label>
        <button type="button" onClick={() => setLowData(false)} aria-label={bi('Fermer', 'Close')} className="px-1 text-emerald-900/70 hover:text-emerald-900">✕</button>
      </div>
    </div>
  )
}
