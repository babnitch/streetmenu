'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useLanguage, useBi } from '@/lib/languageContext'

// Enriched voucher row returned by GET /api/admin/vouchers — includes the
// server-derived status and the joined restaurant name.
interface VoucherWithStatus {
  id: string
  code: string
  discount_type: 'percent' | 'fixed'
  discount_value: number
  min_order: number | null
  max_uses: number | null
  current_uses: number | null
  per_customer_max?: number | null
  is_active: boolean
  expires_at: string | null
  city: string | null
  restaurant_id: string | null
  restaurant_name: string | null
  status: 'active' | 'inactive' | 'expired' | 'exhausted'
  created_at: string
}

interface RestaurantLite { id: string; name: string }

export default function AdminVouchersPage() {
  const bi = useBi()
  const { t } = useLanguage()
  const [vouchers, setVouchers] = useState<VoucherWithStatus[]>([])
  const [restaurants, setRestaurants] = useState<RestaurantLite[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const [code, setCode] = useState('')
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent')
  const [discountValue, setDiscountValue] = useState('')
  const [minOrder, setMinOrder] = useState('0')
  const [maxUses, setMaxUses] = useState('')
  const [perCustomerMax, setPerCustomerMax] = useState('1')
  const [expiresAt, setExpiresAt] = useState('')
  const [city, setCity] = useState('')
  const [restaurantId, setRestaurantId] = useState('')  // empty = platform-wide
  const [isActive, setIsActive] = useState(true)

  useEffect(() => {
    fetchVouchers()
    // Restaurant list for the scope dropdown. Anon-readable; only needs
    // id + name so RLS on other columns doesn't matter.
    supabase.from('restaurants').select('id, name').is('deleted_at', null).neq('status', 'deleted').order('name')
      .then(({ data }) => { if (data) setRestaurants(data) })
  }, [])

  async function fetchVouchers() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/vouchers', { cache: 'no-store' })
      const data = await res.json()
      if (res.ok && Array.isArray(data.vouchers)) setVouchers(data.vouchers)
    } finally {
      setLoading(false)
    }
  }

  async function createVoucher() {
    if (!discountValue) return
    setSaving(true)
    await fetch('/api/admin/vouchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code.trim().toUpperCase(),     // blank triggers TCHOP-XXXX auto-gen server-side
        discount_type: discountType,
        discount_value: parseFloat(discountValue),
        min_order: parseFloat(minOrder) || 0,
        max_uses: maxUses ? parseInt(maxUses) : null,
        per_customer_max: perCustomerMax ? parseInt(perCustomerMax) : 1,
        expires_at: expiresAt || null,
        city: city.trim() || null,
        restaurant_id: restaurantId || null,
        is_active: isActive,
      }),
    })
    setSaving(false)
    setShowForm(false)
    resetForm()
    fetchVouchers()
  }

  function resetForm() {
    setCode(''); setDiscountType('percent'); setDiscountValue('')
    setMinOrder('0'); setMaxUses(''); setPerCustomerMax('1')
    setExpiresAt(''); setCity(''); setRestaurantId(''); setIsActive(true)
  }

  async function toggleActive(v: VoucherWithStatus) {
    await fetch(`/api/admin/vouchers/${v.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !v.is_active }),
    })
    fetchVouchers()
  }

  async function deleteVoucher(v: VoucherWithStatus) {
    if (!confirm(`Supprimer ${v.code}? / Delete ${v.code}?`)) return
    const res = await fetch(`/api/admin/vouchers/${v.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      alert(data.error ?? bi('Erreur', 'Error'))
      return
    }
    fetchVouchers()
  }

  const totalUses = vouchers.reduce((s, v) => s + (v.current_uses ?? 0), 0)
  const activeCount = vouchers.filter(v => v.status === 'active').length

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard label={t('admin.vchTotal')} value={vouchers.length} />
        <StatCard label={t('admin.vchActive')} value={activeCount} accent />
        <StatCard label={t('admin.vchUses')} value={totalUses} />
      </div>

      {/* Header row */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-ink-primary">{t('admin.vchTitle')}</h1>
        <button
          onClick={() => setShowForm(s => !s)}
          className="bg-brand hover:bg-brand-dark text-white px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
        >
          {showForm ? t('admin.vchCancel') : t('admin.vchCreateBtn')}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs text-ink-secondary mb-1">{t('admin.vchCode')}</label>
              <input
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
                placeholder={t('admin.vchCodePh')}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand uppercase font-mono"
              />
            </div>

            <div>
              <label className="block text-xs text-ink-secondary mb-1">{t('admin.vchType')}</label>
              <select
                value={discountType}
                onChange={e => setDiscountType(e.target.value as 'percent' | 'fixed')}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              >
                <option value="percent">{t('admin.vchPercent')}</option>
                <option value="fixed">{t('admin.vchFixed')}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-ink-secondary mb-1">{t('admin.vchValue')}</label>
              <input
                type="number"
                value={discountValue}
                onChange={e => setDiscountValue(e.target.value)}
                placeholder={t('admin.vchValuePh')}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>

            <div>
              <label className="block text-xs text-ink-secondary mb-1">{t('admin.vchMinOrder')}</label>
              <input
                type="number"
                value={minOrder}
                onChange={e => setMinOrder(e.target.value)}
                placeholder={t('admin.vchMinPh')}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>

            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Max utilisations', 'Max uses')}</label>
              <input
                type="number"
                value={maxUses}
                onChange={e => setMaxUses(e.target.value)}
                placeholder="0 = illimité / unlimited"
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>

            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Par client', 'Per customer')}</label>
              <input
                type="number"
                value={perCustomerMax}
                onChange={e => setPerCustomerMax(e.target.value)}
                placeholder="1 = one-time"
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>

            <div>
              <label className="block text-xs text-ink-secondary mb-1">{t('admin.vchExpiry')}</label>
              <input
                type="date"
                value={expiresAt}
                onChange={e => setExpiresAt(e.target.value)}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>

            <div className="col-span-2">
              <label className="block text-xs text-ink-secondary mb-1">{bi('Portée', 'Scope')}</label>
              <select
                value={restaurantId}
                onChange={e => setRestaurantId(e.target.value)}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white"
              >
                <option value="">{bi('Plateforme', 'Platform-wide')}</option>
                {restaurants.map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Ville', 'City')}</label>
              <input
                value={city}
                onChange={e => setCity(e.target.value)}
                placeholder={t('admin.vchCityPh')}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>

            <div className="col-span-2 flex items-center gap-2">
              <input
                type="checkbox"
                id="vch-active"
                checked={isActive}
                onChange={e => setIsActive(e.target.checked)}
                className="accent-brand"
              />
              <label htmlFor="vch-active" className="text-sm text-ink-primary cursor-pointer">Activer immédiatement</label>
            </div>
          </div>

          <button
            onClick={createVoucher}
            disabled={saving || !code.trim() || !discountValue}
            className="w-full mt-4 bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
          >
            {saving ? t('admin.vchLoading') : t('admin.vchSaveBtn')}
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-ink-tertiary">{t('admin.vchLoading')}</div>
      ) : vouchers.length === 0 ? (
        <div className="text-center py-12 text-ink-tertiary">
          <div className="text-4xl mb-3">🏷️</div>
          <p>{t('admin.vchNoVouchers')}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted border-b border-divider">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{t('admin.vchCode')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{t('admin.vchValue')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{bi('Portée', 'Scope')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{t('admin.vchUseCount')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{t('admin.vchExpiry')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{t('admin.vchStatus')}</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {vouchers.map(v => (
                  <tr key={v.id} className="hover:bg-surface-muted transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-mono font-bold text-ink-primary">{v.code}</p>
                    </td>
                    <td className="px-4 py-3 text-brand-dark font-semibold">
                      {v.discount_type === 'percent' ? `${v.discount_value}%` : `${Number(v.discount_value).toLocaleString()} FCFA`}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary text-xs">
                      {v.restaurant_name
                        ? <span className="bg-brand-light text-brand-darker px-2 py-0.5 rounded-full">{v.restaurant_name}</span>
                        : <span className="bg-brand-light text-brand-darker px-2 py-0.5 rounded-full">Plateforme</span>}
                      {v.city && <span className="ml-1 text-ink-tertiary">· {v.city}</span>}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {v.current_uses ?? 0}{v.max_uses ? `/${v.max_uses}` : ''}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary text-xs">
                      {v.expires_at
                        ? new Date(v.expires_at).toLocaleDateString('fr-FR')
                        : <span className="text-ink-tertiary">{t('admin.vchNoExpiry')}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <VoucherStatusBadge status={v.status} onToggle={() => toggleActive(v)} isActive={v.is_active} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(v.current_uses ?? 0) === 0 && (
                        <button
                          onClick={() => deleteVoucher(v)}
                          className="text-xs text-danger hover:text-danger font-semibold"
                        >
                          🗑️
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// Status pill on the voucher row. Clickable when active/inactive (toggles
// is_active via the PATCH route); read-only for terminal-ish expired and
// exhausted states.
function VoucherStatusBadge({
  status, isActive, onToggle,
}: {
  status: 'active' | 'inactive' | 'expired' | 'exhausted'
  isActive: boolean
  onToggle: () => void
}) {
  const bi = useBi()
  const STYLES: Record<typeof status, { cls: string; label: string }> = {
    active:    { cls: 'bg-brand-light text-brand-darker hover:bg-brand-badge', label: '✅ Active' },
    inactive:  { cls: 'bg-surface-muted text-ink-secondary hover:bg-divider',    label: bi('Inactif', 'Inactive') },
    expired:   { cls: 'bg-brand-light text-danger',                         label: bi('⏰ Expiré', 'Expired') },
    exhausted: { cls: 'bg-brand-light text-warning',                     label: bi('🪫 Épuisé', 'Exhausted') },
  }
  const s = STYLES[status]
  const clickable = status === 'active' || status === 'inactive'
  return (
    <button
      onClick={clickable ? onToggle : undefined}
      disabled={!clickable}
      className={`text-xs font-semibold px-2.5 py-1 rounded-full transition-colors ${s.cls} ${clickable ? '' : 'cursor-default opacity-80'}`}
      title={clickable ? (isActive ? bi('Désactiver', 'Deactivate') : bi('Activer', 'Activate')) : s.label}
    >
      {s.label}
    </button>
  )
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm">
      <p className="text-xs text-ink-tertiary mb-1">{label}</p>
      <p className={`text-2xl font-black ${accent ? 'text-brand' : 'text-ink-primary'}`}>{value}</p>
    </div>
  )
}
