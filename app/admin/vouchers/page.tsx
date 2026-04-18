'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useLanguage } from '@/lib/languageContext'
import { Voucher } from '@/types'

export default function AdminVouchersPage() {
  const { t } = useLanguage()
  const [vouchers, setVouchers] = useState<Voucher[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const [code, setCode] = useState('')
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent')
  const [discountValue, setDiscountValue] = useState('')
  const [minOrder, setMinOrder] = useState('0')
  const [maxUses, setMaxUses] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [city, setCity] = useState('')
  const [isActive, setIsActive] = useState(true)

  useEffect(() => {
    fetchVouchers()
  }, [])

  async function fetchVouchers() {
    setLoading(true)
    const { data } = await supabase.from('vouchers').select('*').order('created_at', { ascending: false })
    if (data) setVouchers(data)
    setLoading(false)
  }

  async function createVoucher() {
    if (!code.trim() || !discountValue) return
    setSaving(true)
    await fetch('/api/admin/vouchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code.trim().toUpperCase(),
        discount_type: discountType,
        discount_value: parseFloat(discountValue),
        min_order: parseFloat(minOrder) || 0,
        max_uses: maxUses ? parseInt(maxUses) : null,
        expires_at: expiresAt || null,
        city: city.trim() || null,
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
    setMinOrder('0'); setMaxUses(''); setExpiresAt(''); setCity(''); setIsActive(true)
  }

  async function toggleActive(v: Voucher) {
    await fetch(`/api/admin/vouchers/${v.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !v.is_active }),
    })
    setVouchers(prev => prev.map(x => x.id === v.id ? { ...x, is_active: !v.is_active } : x))
  }

  const totalUses = vouchers.reduce((s, v) => s + (v.uses_count ?? 0), 0)
  const activeCount = vouchers.filter(v => v.is_active).length

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
        <h1 className="text-xl font-bold text-gray-900">{t('admin.vchTitle')}</h1>
        <button
          onClick={() => setShowForm(s => !s)}
          className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
        >
          {showForm ? t('admin.vchCancel') : t('admin.vchCreateBtn')}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs text-gray-500 mb-1">{t('admin.vchCode')}</label>
              <input
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
                placeholder={t('admin.vchCodePh')}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400 uppercase font-mono"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('admin.vchType')}</label>
              <select
                value={discountType}
                onChange={e => setDiscountType(e.target.value as 'percent' | 'fixed')}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
              >
                <option value="percent">{t('admin.vchPercent')}</option>
                <option value="fixed">{t('admin.vchFixed')}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('admin.vchValue')}</label>
              <input
                type="number"
                value={discountValue}
                onChange={e => setDiscountValue(e.target.value)}
                placeholder={t('admin.vchValuePh')}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('admin.vchMinOrder')}</label>
              <input
                type="number"
                value={minOrder}
                onChange={e => setMinOrder(e.target.value)}
                placeholder={t('admin.vchMinPh')}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">Max utilisations</label>
              <input
                type="number"
                value={maxUses}
                onChange={e => setMaxUses(e.target.value)}
                placeholder={t('admin.vchMaxUsesPh')}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('admin.vchExpiry')}</label>
              <input
                type="date"
                value={expiresAt}
                onChange={e => setExpiresAt(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">Ville</label>
              <input
                value={city}
                onChange={e => setCity(e.target.value)}
                placeholder={t('admin.vchCityPh')}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
              />
            </div>

            <div className="col-span-2 flex items-center gap-2">
              <input
                type="checkbox"
                id="vch-active"
                checked={isActive}
                onChange={e => setIsActive(e.target.checked)}
                className="accent-orange-500"
              />
              <label htmlFor="vch-active" className="text-sm text-gray-700 cursor-pointer">Activer immédiatement</label>
            </div>
          </div>

          <button
            onClick={createVoucher}
            disabled={saving || !code.trim() || !discountValue}
            className="w-full mt-4 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
          >
            {saving ? t('admin.vchLoading') : t('admin.vchSaveBtn')}
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">{t('admin.vchLoading')}</div>
      ) : vouchers.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">🏷️</div>
          <p>{t('admin.vchNoVouchers')}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('admin.vchCode')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('admin.vchValue')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('admin.vchMinOrder')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('admin.vchUseCount')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('admin.vchExpiry')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('admin.vchStatus')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {vouchers.map(v => (
                  <tr key={v.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-mono font-bold text-gray-900">{v.code}</p>
                    </td>
                    <td className="px-4 py-3 text-orange-600 font-semibold">
                      {v.discount_type === 'percent' ? `${v.discount_value}%` : `${Number(v.discount_value).toLocaleString()} FCFA`}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {Number(v.min_order).toLocaleString()} FCFA
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {v.uses_count}{v.max_uses ? `/${v.max_uses}` : ''}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {v.expires_at
                        ? new Date(v.expires_at).toLocaleDateString('fr-FR')
                        : <span className="text-gray-300">{t('admin.vchNoExpiry')}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => toggleActive(v)}
                        className={`text-xs font-semibold px-2.5 py-1 rounded-full transition-colors ${
                          v.is_active
                            ? 'bg-green-100 text-green-700 hover:bg-green-200'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}
                      >
                        {v.is_active ? t('admin.vchToggleActive') : t('admin.vchToggleInactive')}
                      </button>
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

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-black ${accent ? 'text-orange-500' : 'text-gray-900'}`}>{value}</p>
    </div>
  )
}
