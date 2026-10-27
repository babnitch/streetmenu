'use client'

// Admin → 📨 Messages → "Codes de connexion": login codes sent in the last
// 24 h against the daily cap, what was blocked and why, and the latest
// attempts. Backed by GET /api/admin/auth-codes.

import { useCallback, useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'

interface Row { id: string; phone: string; ip: string | null; channel: string; status: 'sent' | 'failed' | 'blocked'; reason: string | null; created_at: string }
interface Data { cap: number; sent: number; failed: number; blocked: number; blockedBy: Record<string, number>; recent: Row[] }

const REASON: Record<string, [string, string]> = {
  resend_cooldown: ['30 s entre deux codes', '30 s between codes'],
  phone_hourly:    ['limite par numéro / heure', 'per-number hourly limit'],
  ip_hourly:       ['limite par IP / heure', 'per-IP hourly limit'],
  daily_cap:       ['plafond journalier', 'daily cap'],
}

export default function AuthCodesPanel() {
  const bi = useBi()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/admin/auth-codes', { cache: 'no-store' })
      const d = await r.json()
      if (!r.ok) setError(d.error ?? 'Erreur / Error'); else setData(d)
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const used = data ? data.sent + data.failed : 0
  const reasonLabel = (r: string | null) => r && REASON[r] ? bi(REASON[r][0], REASON[r][1]) : (r ?? '—')
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-divider p-4 mb-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="font-bold text-ink-primary text-sm">🔑 {bi('Codes de connexion (24 h)', 'Login codes (24 h)')}</h2>
        <button onClick={load} disabled={loading}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-divider hover:bg-surface-muted disabled:opacity-50">
          {loading ? '…' : bi('Actualiser', 'Refresh')}
        </button>
      </div>
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      {data && (
        <>
          <p className={`text-sm font-semibold ${used >= data.cap ? 'text-danger' : 'text-ink-primary'}`}>
            {used} / {data.cap} {bi('envoyés', 'sent')}
            {used >= data.cap && <span className="ml-2 text-xs">⛔ {bi('plafond atteint', 'cap reached')}</span>}
          </p>
          <p className="text-xs text-ink-tertiary mt-0.5">
            {bi('Échecs', 'Failed')}: {data.failed} · {bi('Bloqués', 'Blocked')}: {data.blocked}
            {Object.entries(data.blockedBy).map(([k, n]) => ` · ${reasonLabel(k)} ${n}`).join('')}
          </p>
          {data.recent.length > 0 && (
            <button type="button" onClick={() => setOpen(o => !o)}
              className="mt-2 text-xs font-semibold text-brand hover:text-brand-dark">
              {open ? bi('Masquer le détail', 'Hide details') : bi('Voir le détail', 'Show details')}
            </button>
          )}
          {open && (
            <ul className="divide-y divide-divider mt-2">
              {data.recent.map(r => (
                <li key={r.id} className="py-1.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="text-ink-tertiary">{time(r.created_at)}</span>
                  <span className="font-mono text-ink-secondary">{r.phone}</span>
                  <span className="text-ink-secondary">{r.channel === 'sms' ? 'SMS' : 'WhatsApp'}</span>
                  <span className={r.status === 'sent' ? 'text-emerald-700' : r.status === 'failed' ? 'text-danger' : 'text-amber-700'}>
                    {r.status === 'sent' ? bi('envoyé', 'sent') : r.status === 'failed' ? bi('échec', 'failed') : bi('bloqué', 'blocked')}
                    {r.reason ? ` · ${reasonLabel(r.reason)}` : ''}
                  </span>
                  {r.ip && <span className="font-mono text-ink-tertiary">{r.ip}</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-ink-tertiary mt-2">
            {bi('Plafond modifiable dans Supabase : platform_settings → auth_codes_daily_cap.', 'Cap set in Supabase: platform_settings → auth_codes_daily_cap.')}
          </p>
        </>
      )}
    </div>
  )
}
