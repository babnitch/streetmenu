'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import { useBi } from '@/lib/languageContext'

type Placement = 'top_list' | 'feed_card' | 'banner'
type StatusFilter = 'all' | 'pending_review' | 'active' | 'paused' | 'completed' | 'rejected'

interface PromoRow {
  id:             string
  promoter_id:    string
  target_type:    'restaurant' | 'event'
  target_id:      string
  target_name:    string
  placement:      Placement
  city:           string
  start_date:     string
  end_date:       string
  total_budget:   number
  amount_spent:   number
  impressions:    number
  clicks:         number
  payment_status: string
  status:         string
  rejection_reason: string | null
  created_at:     string
  customers:      { name: string; phone: string } | null
}

interface Pricing {
  id:                string
  placement:         Placement
  price_per_day:     number
  min_duration_days: number
  max_duration_days: number
}

function placementLabel(p: Placement, bi: (a: string, b: string) => string): string {
  if (p === 'top_list')  return bi('🔝 Tête de liste', '🔝 Top of list')
  if (p === 'feed_card') return bi('📌 Fil', '📌 Feed')
  return bi('📢 Bannière', '📢 Banner')
}

function statusLabel(s: string, bi: (a: string, b: string) => string): string {
  switch (s) {
    case 'pending_review': return '⏳ ' + bi('À valider', 'Pending')
    case 'active':         return '🟢 ' + bi('Actif', 'Active')
    case 'paused':         return '⏸️ ' + bi('En pause', 'Paused')
    case 'completed':      return '✅ ' + bi('Terminé', 'Completed')
    case 'rejected':       return '❌ ' + bi('Rejeté', 'Rejected')
    default:               return '📝 ' + bi('Brouillon', 'Draft')
  }
}

// Admin Promotions sub-tab.
//   - Top: revenue card + pricing-per-placement table (editable inline)
//   - Filter tabs (All / Pending / Active / Paused / Completed / Rejected)
//   - List of promotions with promoter + target, stats, action buttons
export default function AdminPromotionsPage() {
  const bi = useBi()
  const [tab, setTab] = useState<StatusFilter>('all')
  const [promos, setPromos] = useState<PromoRow[]>([])
  const [revenue, setRevenue] = useState(0)
  const [pricing, setPricing] = useState<Pricing[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [editingPlacement, setEditingPlacement] = useState<Placement | null>(null)
  const [editPrice, setEditPrice] = useState(0)
  const [editMin, setEditMin] = useState(0)
  const [editMax, setEditMax] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [pRes, prRes] = await Promise.all([
        fetch(`/api/admin/promotions?status=${tab}`, { cache: 'no-store' }),
        fetch('/api/admin/promotions/pricing', { cache: 'no-store' }),
      ])
      const [pD, prD] = await Promise.all([pRes.json(), prRes.json()])
      if (Array.isArray(pD?.promotions)) setPromos(pD.promotions)
      setRevenue(Number(pD?.revenue_total ?? 0))
      if (Array.isArray(prD?.pricing)) setPricing(prD.pricing)
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => { load() }, [load])

  async function approve(id: string) {
    setBusy(id)
    try {
      const res = await fetch(`/api/admin/promotions/${id}/approve`, { method: 'POST' })
      if (res.ok) await load()
    } finally { setBusy(null) }
  }
  async function reject(id: string) {
    const reason = prompt(bi('Raison du rejet (optionnel):', 'Reason for rejection (optional):'), '')
    if (reason === null) return
    setBusy(id)
    try {
      const res = await fetch(`/api/admin/promotions/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || null }),
      })
      if (res.ok) await load()
    } finally { setBusy(null) }
  }
  async function pause(id: string)  { return changeStatus(id, 'pause') }
  async function resume(id: string) { return changeStatus(id, 'resume') }
  async function changeStatus(id: string, action: 'pause' | 'resume') {
    setBusy(id)
    try {
      const res = await fetch(`/api/promotions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (res.ok) await load()
    } finally { setBusy(null) }
  }

  function startEditPricing(p: Pricing) {
    setEditingPlacement(p.placement)
    setEditPrice(p.price_per_day)
    setEditMin(p.min_duration_days)
    setEditMax(p.max_duration_days)
  }
  async function savePricing() {
    if (!editingPlacement) return
    setBusy('pricing')
    try {
      const res = await fetch('/api/admin/promotions/pricing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          placement:         editingPlacement,
          price_per_day:     editPrice,
          min_duration_days: editMin,
          max_duration_days: editMax,
        }),
      })
      if (res.ok) {
        setEditingPlacement(null)
        await load()
      }
    } finally { setBusy(null) }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-primary">📢 {bi('Promotions', 'Promotions')}</h1>
        <p className="text-sm text-ink-secondary mt-0.5">
          {bi('Annonces payantes des restaurants et événements.', 'Paid ads from restaurants and events.')}
        </p>
      </div>

      {/* Revenue */}
      <div className="bg-white rounded-2xl p-4 shadow-sm mb-6">
        <p className="text-xs text-ink-secondary font-medium">{bi('Revenu publicitaire total', 'Total ad revenue')}</p>
        <p className="text-2xl font-bold text-brand mt-1">{revenue.toLocaleString()} FCFA</p>
      </div>

      {/* Pricing */}
      <div className="bg-white rounded-2xl p-4 shadow-sm mb-6">
        <h2 className="font-bold text-ink-primary mb-3">💲 {bi('Tarification', 'Pricing')}</h2>
        <div className="space-y-2">
          {pricing.map(p => {
            const isEditing = editingPlacement === p.placement
            return (
              <div key={p.id} className="bg-surface-muted rounded-xl p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="font-semibold text-sm">{placementLabel(p.placement, bi)}</span>
                  {!isEditing && (
                    <button
                      onClick={() => startEditPricing(p)}
                      className="text-xs font-semibold text-brand hover:text-brand-dark"
                    >
                      ✏️ {bi('Modifier', 'Edit')}
                    </button>
                  )}
                </div>
                {isEditing ? (
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs text-ink-tertiary mb-0.5">FCFA/j</label>
                      <input type="number" min="0" value={editPrice} onChange={e => setEditPrice(Number(e.target.value))} className="w-full bg-white border border-divider rounded-lg px-2 py-1 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs text-ink-tertiary mb-0.5">Min j</label>
                      <input type="number" min="1" value={editMin} onChange={e => setEditMin(Number(e.target.value))} className="w-full bg-white border border-divider rounded-lg px-2 py-1 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs text-ink-tertiary mb-0.5">Max j</label>
                      <input type="number" min="1" value={editMax} onChange={e => setEditMax(Number(e.target.value))} className="w-full bg-white border border-divider rounded-lg px-2 py-1 text-sm" />
                    </div>
                    <div className="col-span-3 flex gap-2 mt-1">
                      <button onClick={savePricing} disabled={busy === 'pricing'} className="flex-1 bg-brand text-white text-sm font-semibold py-1.5 rounded-lg disabled:opacity-50">💾</button>
                      <button onClick={() => setEditingPlacement(null)} className="flex-1 bg-white border border-divider text-sm font-semibold py-1.5 rounded-lg">{bi('Annuler', 'Cancel')}</button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-ink-secondary">
                    {p.price_per_day.toLocaleString()} FCFA/j · {p.min_duration_days}-{p.max_duration_days} {bi('jours', 'days')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 bg-surface-muted p-1 rounded-xl w-fit mb-5 overflow-x-auto">
        {(['all', 'pending_review', 'active', 'paused', 'completed', 'rejected'] as StatusFilter[]).map(s => (
          <button
            key={s}
            onClick={() => setTab(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
              tab === s ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
            }`}
          >
            {s === 'all' ? bi('Tous', 'All')
              : s === 'pending_review' ? bi('À valider', 'Pending')
              : s === 'active' ? bi('Actifs', 'Active')
              : s === 'paused' ? bi('Pause', 'Paused')
              : s === 'completed' ? bi('Terminés', 'Completed')
              : bi('Rejetés', 'Rejected')}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3 animate-bounce">📢</div>
          <p>{bi('Chargement…', 'Loading…')}</p>
        </div>
      ) : promos.length === 0 ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3">📭</div>
          <p>{bi('Aucune promotion.', 'No promotions.')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {promos.map(p => {
            const ctr = p.impressions > 0 ? ((p.clicks / p.impressions) * 100).toFixed(1) : '0.0'
            return (
              <div key={p.id} className="bg-white rounded-2xl shadow-sm p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink-primary text-sm">
                      {statusLabel(p.status, bi)} · {p.target_type === 'restaurant' ? '🏪' : '🎉'} {p.target_name}
                    </p>
                    <p className="text-xs text-ink-secondary mt-0.5">
                      👤 {p.customers?.name ?? '—'} {p.customers?.phone ? `(${p.customers.phone})` : ''}
                    </p>
                    <p className="text-xs text-ink-tertiary mt-0.5">
                      {placementLabel(p.placement, bi)} · 📍 {p.city} ·
                      {' '}{new Date(p.start_date).toLocaleDateString('fr-FR')} → {new Date(p.end_date).toLocaleDateString('fr-FR')}
                    </p>
                    <p className="text-xs text-ink-tertiary mt-0.5">
                      💰 {p.total_budget.toLocaleString()} FCFA · 👁️ {p.impressions} · 🖱️ {p.clicks} · {ctr}% CTR
                    </p>
                    {p.rejection_reason && (
                      <p className="text-xs text-rose-600 mt-1">❌ {p.rejection_reason}</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 flex-shrink-0">
                    {p.status === 'pending_review' && (
                      <>
                        <button
                          onClick={() => approve(p.id)}
                          disabled={busy === p.id}
                          className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 disabled:opacity-50"
                        >
                          ✅ {bi('Approuver', 'Approve')}
                        </button>
                        <button
                          onClick={() => reject(p.id)}
                          disabled={busy === p.id}
                          className="text-xs font-semibold text-rose-600 hover:text-rose-700 disabled:opacity-50"
                        >
                          ❌ {bi('Rejeter', 'Reject')}
                        </button>
                      </>
                    )}
                    {p.status === 'active' && (
                      <button
                        onClick={() => pause(p.id)}
                        disabled={busy === p.id}
                        className="text-xs font-semibold text-ink-secondary hover:text-ink-primary disabled:opacity-50"
                      >
                        ⏸️ {bi('Pause', 'Pause')}
                      </button>
                    )}
                    {p.status === 'paused' && (
                      <button
                        onClick={() => resume(p.id)}
                        disabled={busy === p.id}
                        className="text-xs font-semibold text-brand hover:text-brand-dark disabled:opacity-50"
                      >
                        ▶️ {bi('Reprendre', 'Resume')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
