'use client'

import { useState, useEffect, useCallback } from 'react'
import { useBi } from '@/lib/languageContext'

interface EventVoucher {
  id:               string
  code:             string
  discount_type:    'percent' | 'fixed'
  discount_value:   number
  max_uses:         number | null
  current_uses:     number | null
  per_customer_max: number | null
  is_active:        boolean
  expires_at:       string | null
  status:           'active' | 'inactive' | 'expired' | 'exhausted'
}

// Promo-code management for a single event, mounted inside MyEventsPanel.
// Organizer creates event-scoped vouchers (event_id pinned server-side) and
// sees their live status + usage. Create + list only — matches the spec.
export default function EventVouchersPanel({ eventId }: { eventId: string }) {
  const bi = useBi()
  const [vouchers, setVouchers] = useState<EventVoucher[]>([])
  const [loading, setLoading]   = useState(true)
  const [adding, setAdding]     = useState(false)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  const [code, setCode]                 = useState('')
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent')
  const [discountValue, setDiscountValue] = useState('')
  const [maxUses, setMaxUses]           = useState('')
  const [perCustomerMax, setPerCustomerMax] = useState('1')
  const [expiresAt, setExpiresAt]       = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/events/${eventId}/vouchers`, { cache: 'no-store' })
      const d = await r.json()
      if (Array.isArray(d?.vouchers)) setVouchers(d.vouchers)
    } finally {
      setLoading(false)
    }
  }, [eventId])
  useEffect(() => { load() }, [load])

  function resetForm() {
    setCode(''); setDiscountType('percent'); setDiscountValue('')
    setMaxUses(''); setPerCustomerMax('1'); setExpiresAt(''); setError('')
  }

  async function create() {
    const value = Number(discountValue)
    if (!Number.isFinite(value) || value <= 0) {
      setError(bi('Valeur invalide.', 'Invalid value.')); return
    }
    if (discountType === 'percent' && value > 100) {
      setError(bi('Le pourcentage ne peut dépasser 100.', 'Percentage cannot exceed 100.')); return
    }
    setSaving(true); setError('')
    try {
      const res = await fetch(`/api/events/${eventId}/vouchers`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code:             code.trim() || undefined,
          discount_type:    discountType,
          discount_value:   value,
          max_uses:         maxUses.trim() || null,
          per_customer_max: perCustomerMax.trim() || 1,
          expires_at:       expiresAt || null,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d?.error ?? bi('Erreur', 'Error')); return }
      resetForm(); setAdding(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const badge = (s: EventVoucher['status']) => {
    const map: Record<EventVoucher['status'], { cls: string; label: string }> = {
      active:    { cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200', label: bi('Actif', 'Active') },
      inactive:  { cls: 'bg-surface-muted text-ink-secondary',                      label: bi('Inactif', 'Inactive') },
      expired:   { cls: 'bg-amber-50 text-amber-700 border border-amber-200',       label: bi('Expiré', 'Expired') },
      exhausted: { cls: 'bg-rose-50 text-rose-700 border border-rose-200',          label: bi('Épuisé', 'Used up') },
    }
    return map[s]
  }

  const INPUT = 'w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm'

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
          🎫 {bi('Codes promo', 'Promo codes')}
        </p>
        {!adding && (
          <button
            onClick={() => { resetForm(); setAdding(true) }}
            className="text-xs font-semibold text-brand hover:text-brand-dark"
          >
            + {bi('Nouveau', 'New')}
          </button>
        )}
      </div>

      {adding && (
        <div className="space-y-2 mb-4 border border-divider rounded-xl p-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-secondary">{bi('Code (optionnel)', 'Code (optional)')}</span>
              <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder={bi('Auto', 'Auto')} className={`${INPUT} uppercase`} />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-secondary">{bi('Type', 'Type')}</span>
              <select value={discountType} onChange={e => setDiscountType(e.target.value as 'percent' | 'fixed')} className={INPUT}>
                <option value="percent">% ({bi('pourcentage', 'percentage')})</option>
                <option value="fixed">FCFA ({bi('montant fixe', 'fixed amount')})</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-secondary">{discountType === 'percent' ? bi('Valeur %', 'Value %') : bi('Valeur FCFA', 'Value FCFA')}</span>
              <input type="number" min={1} value={discountValue} onChange={e => setDiscountValue(e.target.value)} className={INPUT} />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-secondary">{bi('Max usages', 'Max uses')}</span>
              <input type="number" min={0} value={maxUses} onChange={e => setMaxUses(e.target.value)} placeholder="∞" className={INPUT} />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-secondary">{bi('Par client', 'Per customer')}</span>
              <input type="number" min={0} value={perCustomerMax} onChange={e => setPerCustomerMax(e.target.value)} className={INPUT} />
            </label>
          </div>
          <label className="block">
            <span className="text-[11px] font-semibold text-ink-secondary">{bi('Expire le (optionnel)', 'Expires (optional)')}</span>
            <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} className={INPUT} />
          </label>
          {error && <p className="text-xs text-rose-600">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={() => { setAdding(false); resetForm() }} disabled={saving} className="flex-1 text-xs font-semibold py-2 rounded-xl bg-surface-muted text-ink-secondary hover:bg-divider disabled:opacity-50">
              {bi('Annuler', 'Cancel')}
            </button>
            <button onClick={create} disabled={saving || !discountValue.trim()} className="flex-1 text-xs font-semibold py-2 rounded-xl bg-brand text-white hover:bg-brand-dark disabled:opacity-50">
              {saving ? '…' : bi('Créer', 'Create')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-ink-tertiary text-center py-3">…</p>
      ) : vouchers.length === 0 ? (
        <p className="text-xs text-ink-tertiary text-center py-3">
          {bi('Aucun code promo pour cet événement.', 'No promo codes for this event yet.')}
        </p>
      ) : (
        <div className="space-y-2">
          {vouchers.map(v => {
            const b = badge(v.status)
            return (
              <div key={v.id} className="flex items-center justify-between gap-2 border border-divider rounded-xl px-3 py-2">
                <div className="min-w-0">
                  <p className="font-bold font-mono text-sm text-ink-primary tracking-wider">{v.code}</p>
                  <p className="text-[11px] text-ink-tertiary">
                    {v.discount_type === 'percent' ? `-${v.discount_value}%` : `-${Number(v.discount_value).toLocaleString()} FCFA`}
                    {' · '}
                    {bi('Utilisé', 'Used')}: {v.current_uses ?? 0}{v.max_uses ? `/${v.max_uses}` : ''}
                    {v.expires_at ? ` · ${bi('exp.', 'exp.')} ${new Date(v.expires_at).toLocaleDateString()}` : ''}
                  </p>
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${b.cls}`}>{b.label}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
