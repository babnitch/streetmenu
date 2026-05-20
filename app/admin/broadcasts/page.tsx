'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import { useBi } from '@/lib/languageContext'

interface BroadcastRow {
  id: string
  sender_id: string
  sender_type: 'publisher' | 'restaurant'
  restaurant_id: string | null
  title: string
  message: string
  target_city: string
  target_categories: string[] | null
  recipient_count: number
  cost: number
  payment_status: string
  status: string
  sent_at: string | null
  created_at: string
  customers: { name: string; phone: string; broadcast_blocked: boolean } | null
  restaurants: { name: string } | null
}

interface Pricing {
  id: string
  price_per_recipient: number
  min_charge: number
  max_message_length: number
  is_active: boolean
}

interface Stats {
  total_active: number
  by_city: Record<string, { total: number; categories: Record<string, number> }>
}

type Tab = 'all' | 'pending' | 'sent' | 'failed'

// Admin Broadcasts sub-tab. Lives at /admin/broadcasts but is also mounted
// inside the /account admin dashboard. Three sections: list + filters,
// subscription stats, and pricing controls.
export default function AdminBroadcastsPage() {
  const bi = useBi()
  const [tab, setTab] = useState<Tab>('all')
  const [broadcasts, setBroadcasts] = useState<BroadcastRow[]>([])
  const [pricing, setPricing] = useState<Pricing | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Pricing edit state
  const [editPricing, setEditPricing] = useState(false)
  const [editPrice, setEditPrice] = useState(0)
  const [editMin, setEditMin] = useState(0)
  const [editMax, setEditMax] = useState(0)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [bRes, pRes, sRes] = await Promise.all([
        fetch(`/api/admin/broadcasts?status=${tab}`, { cache: 'no-store' }),
        fetch('/api/admin/broadcasts/pricing', { cache: 'no-store' }),
        fetch('/api/admin/broadcasts/stats', { cache: 'no-store' }),
      ])
      const [bD, pD, sD] = await Promise.all([bRes.json(), pRes.json(), sRes.json()])
      if (Array.isArray(bD?.broadcasts)) setBroadcasts(bD.broadcasts)
      if (pD?.pricing) {
        setPricing(pD.pricing)
        setEditPrice(pD.pricing.price_per_recipient)
        setEditMin(pD.pricing.min_charge)
        setEditMax(pD.pricing.max_message_length)
      }
      if (sD?.by_city) setStats(sD as Stats)
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => { fetchData() }, [fetchData])

  async function toggleBlock(customerId: string, blocked: boolean) {
    const reason = blocked
      ? prompt(bi('Raison du blocage (optionnel):', 'Reason for blocking (optional):'), '')
      : null
    if (blocked && reason === null) return
    setBusy(customerId)
    try {
      const res = await fetch('/api/admin/broadcasts/block-sender', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId, blocked, reason }),
      })
      if (res.ok) await fetchData()
    } finally {
      setBusy(null)
    }
  }

  async function savePricing() {
    setBusy('pricing')
    try {
      const res = await fetch('/api/admin/broadcasts/pricing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          price_per_recipient: editPrice,
          min_charge: editMin,
          max_message_length: editMax,
        }),
      })
      if (res.ok) {
        setEditPricing(false)
        await fetchData()
      }
    } finally {
      setBusy(null)
    }
  }

  function statusLabel(status: string): string {
    switch (status) {
      case 'sent':    return '✅ ' + bi('Envoyé', 'Sent')
      case 'sending': return '📨 ' + bi('Envoi…', 'Sending…')
      case 'paid':    return '💰 ' + bi('Payé', 'Paid')
      case 'failed':  return '❌ ' + bi('Échec', 'Failed')
      default:        return '⏳ ' + bi('En attente', 'Pending')
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-primary">📢 {bi('Diffusions', 'Broadcasts')}</h1>
        <p className="text-sm text-ink-secondary mt-0.5">
          {bi(
            'Messages payés envoyés aux abonnés.',
            'Paid messages sent to subscribers.',
          )}
        </p>
      </div>

      {/* Pricing card */}
      <div className="bg-white rounded-2xl p-4 shadow-sm mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-ink-primary">💲 {bi('Tarification', 'Pricing')}</h2>
          {!editPricing && (
            <button
              onClick={() => setEditPricing(true)}
              className="text-sm font-semibold text-brand hover:text-brand-dark"
            >
              ✏️ {bi('Modifier', 'Edit')}
            </button>
          )}
        </div>

        {!editPricing ? (
          pricing ? (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-xs text-ink-secondary">{bi('Par abonné', 'Per subscriber')}</p>
                <p className="font-semibold text-ink-primary">{pricing.price_per_recipient.toLocaleString()} FCFA</p>
              </div>
              <div>
                <p className="text-xs text-ink-secondary">{bi('Minimum', 'Minimum')}</p>
                <p className="font-semibold text-ink-primary">{pricing.min_charge.toLocaleString()} FCFA</p>
              </div>
              <div>
                <p className="text-xs text-ink-secondary">{bi('Max caractères', 'Max chars')}</p>
                <p className="font-semibold text-ink-primary">{pricing.max_message_length}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink-tertiary">{bi('Chargement…', 'Loading…')}</p>
          )
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Par abonné (FCFA)', 'Per subscriber (FCFA)')}</label>
              <input type="number" min="0" value={editPrice} onChange={e => setEditPrice(Number(e.target.value))} className="w-full bg-surface-muted border border-divider rounded-xl px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Minimum (FCFA)', 'Minimum (FCFA)')}</label>
              <input type="number" min="0" value={editMin} onChange={e => setEditMin(Number(e.target.value))} className="w-full bg-surface-muted border border-divider rounded-xl px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Max caractères', 'Max chars')}</label>
              <input type="number" min="10" max="4000" value={editMax} onChange={e => setEditMax(Number(e.target.value))} className="w-full bg-surface-muted border border-divider rounded-xl px-2 py-1.5 text-sm" />
            </div>
            <div className="col-span-3 flex gap-2 mt-2">
              <button
                onClick={savePricing}
                disabled={busy === 'pricing'}
                className="flex-1 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white text-sm font-semibold py-2 rounded-xl"
              >
                {busy === 'pricing' ? '…' : bi('💾 Enregistrer', '💾 Save')}
              </button>
              <button
                onClick={() => { setEditPricing(false); if (pricing) { setEditPrice(pricing.price_per_recipient); setEditMin(pricing.min_charge); setEditMax(pricing.max_message_length) } }}
                className="flex-1 bg-surface-muted hover:bg-divider text-ink-primary text-sm font-semibold py-2 rounded-xl"
              >
                {bi('Annuler', 'Cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Subscription stats */}
      <div className="bg-white rounded-2xl p-4 shadow-sm mb-6">
        <h2 className="font-bold text-ink-primary mb-3">🔔 {bi('Abonnés actifs', 'Active subscribers')}</h2>
        {stats ? (
          <div>
            <p className="text-2xl font-bold text-brand mb-3">{stats.total_active}</p>
            <div className="space-y-2">
              {Object.entries(stats.by_city).sort((a, b) => b[1].total - a[1].total).map(([city, data]) => (
                <div key={city} className="bg-surface-muted rounded-xl p-2.5">
                  <p className="text-sm font-semibold text-ink-primary">📍 {city}: <span className="text-brand">{data.total}</span></p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {Object.entries(data.categories).sort((a, b) => b[1] - a[1]).map(([cat, n]) => (
                      <span key={cat} className="text-xs bg-white border border-divider rounded-full px-2 py-0.5">
                        {cat} · {n}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {Object.keys(stats.by_city).length === 0 && (
                <p className="text-sm text-ink-tertiary">{bi('Aucun abonné pour le moment.', 'No subscribers yet.')}</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-tertiary">{bi('Chargement…', 'Loading…')}</p>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 bg-surface-muted p-1 rounded-xl w-fit mb-5">
        {(['all', 'pending', 'sent', 'failed'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
              tab === t ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
            }`}
          >
            {t === 'all' ? bi('Tous', 'All')
              : t === 'pending' ? bi('En attente', 'Pending')
              : t === 'sent' ? bi('Envoyés', 'Sent')
              : bi('Échecs', 'Failed')}
          </button>
        ))}
      </div>

      {/* Broadcast list */}
      {loading ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3 animate-bounce">📢</div>
          <p>{bi('Chargement…', 'Loading…')}</p>
        </div>
      ) : broadcasts.length === 0 ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3">📭</div>
          <p>{bi('Aucune diffusion.', 'No broadcasts.')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {broadcasts.map(b => {
            const senderName = b.customers?.name ?? '(unknown)'
            const restName = b.restaurants?.name
            const blocked = !!b.customers?.broadcast_blocked
            const isOpen = expanded === b.id
            return (
              <div key={b.id} className="bg-white rounded-2xl shadow-sm overflow-hidden">
                <div className="p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink-primary text-sm">
                        {statusLabel(b.status)} · {b.title}
                      </p>
                      <p className="text-xs text-ink-secondary mt-0.5">
                        👤 {senderName} {b.customers?.phone ? `(${b.customers.phone})` : ''}
                        {b.sender_type === 'restaurant' && restName && ` · 🏪 ${restName}`}
                        {blocked && <span className="ml-2 text-rose-600 font-semibold">🚫 {bi('bloqué', 'blocked')}</span>}
                      </p>
                      <p className="text-xs text-ink-tertiary mt-0.5">
                        📍 {b.target_city} · {b.recipient_count} {bi('abonnés', 'subscribers')} · {b.cost.toLocaleString()} FCFA · {new Date(b.created_at).toLocaleDateString('fr-FR')}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <button
                        onClick={() => setExpanded(isOpen ? null : b.id)}
                        className="text-xs font-semibold text-ink-secondary hover:text-ink-primary"
                      >
                        {isOpen ? bi('Masquer', 'Hide') : bi('Voir', 'View')}
                      </button>
                      <button
                        onClick={() => toggleBlock(b.sender_id, !blocked)}
                        disabled={busy === b.sender_id}
                        className={`text-xs font-semibold ${blocked ? 'text-brand hover:text-brand-dark' : 'text-rose-600 hover:text-rose-700'} disabled:opacity-50`}
                      >
                        {blocked
                          ? bi('Débloquer', 'Unblock')
                          : bi('🚫 Bloquer', '🚫 Block')}
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="mt-3 p-3 bg-surface-muted rounded-xl text-sm text-ink-primary whitespace-pre-wrap">
                      {b.message}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
