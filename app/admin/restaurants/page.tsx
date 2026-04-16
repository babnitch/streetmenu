'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Restaurant } from '@/types'
import { useLanguage } from '@/lib/languageContext'

interface RestaurantForm {
  name: string
  description: string
  address: string
  city: string
  lat: string
  lng: string
  phone: string
  whatsapp: string
  logo_url: string
}

const EMPTY_FORM: RestaurantForm = {
  name: '', description: '', address: '', city: '',
  lat: '', lng: '', phone: '', whatsapp: '', logo_url: '',
}

const INPUT = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-50'

function Field({
  label,
  children,
  className = '',
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <label className="block text-xs text-gray-500 font-medium mb-1.5">{label}</label>
      {children}
    </div>
  )
}

type Tab = 'all' | 'pending'

export default function AdminRestaurantsPage() {
  const { t } = useLanguage()
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<RestaurantForm>(EMPTY_FORM)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [cityFilter, setCityFilter] = useState('all')
  const [tab, setTab] = useState<Tab>('all')
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  useEffect(() => {
    fetchRestaurants()
  }, [])

  async function fetchRestaurants() {
    const { data } = await supabase
      .from('restaurants')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setRestaurants(data)
    setLoading(false)
  }

  async function toggleActive(r: Restaurant) {
    const { data } = await supabase
      .from('restaurants')
      .update({ is_active: !r.is_active })
      .eq('id', r.id)
      .select()
      .single()
    if (data) setRestaurants(prev => prev.map(x => x.id === r.id ? data : x))
  }

  async function toggleOpen(r: Restaurant) {
    const { data } = await supabase
      .from('restaurants')
      .update({ is_open: !r.is_open })
      .eq('id', r.id)
      .select()
      .single()
    if (data) setRestaurants(prev => prev.map(x => x.id === r.id ? data : x))
  }

  async function approveRestaurant(r: Restaurant) {
    setActionLoading(r.id + '-approve')
    const { data } = await supabase
      .from('restaurants')
      .update({ is_active: true })
      .eq('id', r.id)
      .select()
      .single()
    if (data) setRestaurants(prev => prev.map(x => x.id === r.id ? data : x))
    setActionLoading(null)
  }

  async function rejectRestaurant(r: Restaurant) {
    if (!confirm(`${t('admin.rejectConfirm')} "${r.name}" ?`)) return
    setActionLoading(r.id + '-reject')
    await supabase.from('restaurants').delete().eq('id', r.id)
    setRestaurants(prev => prev.filter(x => x.id !== r.id))
    setActionLoading(null)
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const path = `restaurants/${Date.now()}-${file.name.replace(/\s+/g, '-')}`
    const { error } = await supabase.storage.from('photos').upload(path, file)
    if (!error) {
      const { data } = supabase.storage.from('photos').getPublicUrl(path)
      setForm(f => ({ ...f, logo_url: data.publicUrl }))
    }
    setUploading(false)
  }

  async function handleSave() {
    if (!form.name || !form.city || !form.lat || !form.lng) {
      alert('Name, city, lat and lng are required')
      return
    }
    setSaving(true)
    const { data, error } = await supabase.from('restaurants').insert({
      name: form.name.trim(),
      description: form.description.trim(),
      address: form.address.trim(),
      city: form.city.trim(),
      lat: parseFloat(form.lat),
      lng: parseFloat(form.lng),
      phone: form.phone.trim(),
      whatsapp: form.whatsapp.trim(),
      logo_url: form.logo_url,
      is_open: false,
      is_active: true,
    }).select().single()
    setSaving(false)
    if (!error && data) {
      setRestaurants(prev => [data, ...prev])
      setForm(EMPTY_FORM)
      setShowForm(false)
    } else {
      alert(error?.message ?? 'Failed to save')
    }
  }

  const pendingRestaurants = restaurants.filter(r => !r.is_active)
  const pendingCount = pendingRestaurants.length
  const activeRestaurants = restaurants.filter(r => r.is_active)
  const cities = ['all', ...Array.from(new Set(activeRestaurants.map(r => r.city).filter(Boolean)))]

  const filteredAll = activeRestaurants.filter(r => {
    const matchCity = cityFilter === 'all' || r.city === cityFilter
    const matchSearch = !search ||
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.city?.toLowerCase().includes(search.toLowerCase()) ||
      r.address?.toLowerCase().includes(search.toLowerCase())
    return matchCity && matchSearch
  })

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('admin.restTitle')}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {activeRestaurants.length} {t('admin.restActive')} · {restaurants.length} {t('admin.restTotal')}
          </p>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="bg-orange-500 hover:bg-orange-600 text-white px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors"
        >
          {showForm ? t('admin.cancelBtn') : t('admin.addRestBtn')}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-100 rounded-xl p-1 w-fit">
        <button
          onClick={() => setTab('all')}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
            tab === 'all'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {t('admin.allTab')} ({activeRestaurants.length})
        </button>
        <button
          onClick={() => setTab('pending')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
            tab === 'pending'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {t('admin.pendingTab')}
          {pendingCount > 0 && (
            <span className="bg-orange-500 text-white text-xs font-bold px-2 py-0.5 rounded-full min-w-[20px] text-center">
              {pendingCount}
            </span>
          )}
        </button>
      </div>

      {/* --- PENDING TAB --- */}
      {tab === 'pending' && (
        <>
          {loading ? (
            <div className="text-center py-16 text-gray-400">
              <div className="text-4xl mb-3 animate-bounce">🍜</div>
              <p>{t('nav.loading')}</p>
            </div>
          ) : pendingCount === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <div className="text-4xl mb-3">✅</div>
              <p className="font-medium text-gray-500">{t('admin.noPending')}</p>
              <p className="text-sm mt-1">{t('admin.noPendingSub')}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {pendingRestaurants.map(r => (
                <div key={r.id} className="bg-white rounded-2xl shadow-sm border border-orange-50 overflow-hidden">
                  <div className="flex gap-4 p-5">
                    <div className="relative w-20 h-20 rounded-xl overflow-hidden flex-shrink-0 bg-orange-50">
                      {r.logo_url ? (
                        <Image src={r.logo_url} alt={r.name} fill className="object-cover" />
                      ) : (
                        <span className="absolute inset-0 flex items-center justify-center text-2xl">🏪</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div>
                          <h3 className="font-bold text-gray-900 text-base">{r.name}</h3>
                          <p className="text-sm text-gray-500">
                            {r.city}{r.neighborhood ? ` · ${r.neighborhood}` : r.address ? ` · ${r.address}` : ''}
                          </p>
                        </div>
                        <span className="bg-amber-100 text-amber-700 text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0">
                          {t('admin.pendingTab')}
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm text-gray-600">
                        {r.owner_name && (
                          <p>
                            <span className="text-gray-400 text-xs">{t('admin.ownerLbl')}</span>
                            <br />{r.owner_name}
                          </p>
                        )}
                        {(r.cuisine_type || r.description) && (
                          <p>
                            <span className="text-gray-400 text-xs">{t('admin.cuisineLbl')}</span>
                            <br />{r.cuisine_type || r.description}
                          </p>
                        )}
                        {r.whatsapp && (
                          <p>
                            <span className="text-gray-400 text-xs">WhatsApp</span>
                            <br />
                            <a
                              href={`https://wa.me/${r.whatsapp.replace(/\D/g, '')}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-green-600 hover:text-green-700 font-mono"
                            >
                              {r.whatsapp}
                            </a>
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="border-t border-gray-50 px-5 py-3 flex gap-3 bg-gray-50/50">
                    <button
                      onClick={() => approveRestaurant(r)}
                      disabled={actionLoading === r.id + '-approve'}
                      className="flex-1 bg-green-500 hover:bg-green-600 disabled:bg-green-300 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                    >
                      {actionLoading === r.id + '-approve' ? '…' : t('admin.approveBtn')}
                    </button>
                    <button
                      onClick={() => rejectRestaurant(r)}
                      disabled={actionLoading === r.id + '-reject'}
                      className="flex-1 bg-white hover:bg-red-50 disabled:opacity-50 text-red-500 border border-red-200 px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                    >
                      {actionLoading === r.id + '-reject' ? '…' : t('admin.rejectBtn')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* --- ALL TAB --- */}
      {tab === 'all' && (
        <>
          {showForm && (
            <div className="bg-white rounded-2xl shadow-sm border border-orange-100 p-6 mb-6">
              <h2 className="font-bold text-gray-900 mb-4">{t('admin.newRest')}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Name *">
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Mama Afrika Grill" className={INPUT} />
                </Field>
                <Field label="City *">
                  <input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
                    placeholder="e.g. Lagos, Nairobi, Accra" className={INPUT} />
                </Field>
                <Field label="Address">
                  <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                    placeholder="Street address" className={INPUT} />
                </Field>
                <Field label="Description">
                  <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    placeholder="Short description" className={INPUT} />
                </Field>
                <Field label="Latitude *">
                  <input type="number" step="any" value={form.lat} onChange={e => setForm(f => ({ ...f, lat: e.target.value }))}
                    placeholder="e.g. 6.5244" className={INPUT} />
                </Field>
                <Field label="Longitude *">
                  <input type="number" step="any" value={form.lng} onChange={e => setForm(f => ({ ...f, lng: e.target.value }))}
                    placeholder="e.g. 3.3792" className={INPUT} />
                </Field>
                <Field label="Phone">
                  <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder="+234 801 234 5678" className={INPUT} />
                </Field>
                <Field label="WhatsApp">
                  <input value={form.whatsapp} onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))}
                    placeholder="+234 801 234 5678" className={INPUT} />
                </Field>
                <Field label="Cover Photo" className="sm:col-span-2">
                  <input type="file" accept="image/*" onChange={handleLogoUpload} className="text-sm text-gray-600" />
                  {uploading && <span className="text-xs text-orange-500 ml-2">Uploading…</span>}
                  {form.logo_url && !uploading && (
                    <div className="relative w-24 h-16 rounded-lg overflow-hidden mt-2">
                      <Image src={form.logo_url} alt="preview" fill className="object-cover" />
                    </div>
                  )}
                </Field>
              </div>
              <div className="mt-4 flex gap-3">
                <button
                  onClick={handleSave}
                  disabled={saving || uploading || !form.name || !form.city || !form.lat || !form.lng}
                  className="bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors"
                >
                  {saving ? t('admin.saving') : t('admin.addRestSaveBtn')}
                </button>
                <button onClick={() => setShowForm(false)} className="text-sm text-gray-500 hover:text-gray-700 px-4">
                  {t('admin.cancelBtn')}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('admin.searchPh')}
              className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-orange-400"
            />
            <select
              value={cityFilter}
              onChange={e => setCityFilter(e.target.value)}
              className="border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-orange-400 bg-white"
            >
              {cities.map(c => (
                <option key={c} value={c}>{c === 'all' ? t('admin.allCities') : c}</option>
              ))}
            </select>
          </div>

          {loading ? (
            <div className="text-center py-16 text-gray-400">
              <div className="text-4xl mb-3 animate-bounce">🍜</div>
              <p>{t('nav.loading')}</p>
            </div>
          ) : filteredAll.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <div className="text-4xl mb-3">🏪</div>
              <p>{t('admin.noResults')}</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
              <div className="hidden sm:grid grid-cols-[2fr_1fr_1.5fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <span>{t('admin.colRest')}</span>
                <span>{t('admin.colCity')}</span>
                <span>{t('admin.colWhatsapp')}</span>
                <span>{t('admin.colOpen')}</span>
                <span>{t('admin.colActive')}</span>
                <span></span>
              </div>

              {filteredAll.map((r, idx) => (
                <div
                  key={r.id}
                  className={`flex flex-col sm:grid sm:grid-cols-[2fr_1fr_1.5fr_1fr_1fr_auto] sm:items-center gap-2 sm:gap-4 px-5 py-4 ${
                    idx < filteredAll.length - 1 ? 'border-b border-gray-50' : ''
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="relative w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 bg-orange-50">
                      {r.logo_url ? (
                        <Image src={r.logo_url} alt={r.name} fill className="object-cover" />
                      ) : (
                        <span className="absolute inset-0 flex items-center justify-center text-lg">🏪</span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 text-sm truncate">{r.name}</p>
                      <p className="text-xs text-gray-400 truncate">{r.address}</p>
                    </div>
                  </div>
                  <div>
                    <span className="text-sm text-gray-600">{r.city || '—'}</span>
                  </div>
                  <div>
                    {r.whatsapp ? (
                      <a
                        href={`https://wa.me/${r.whatsapp.replace(/\D/g, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-green-600 hover:text-green-700 font-mono"
                      >
                        {r.whatsapp}
                      </a>
                    ) : (
                      <span className="text-sm text-gray-400">—</span>
                    )}
                  </div>
                  <div>
                    <ToggleBtn
                      checked={r.is_open}
                      onChange={() => toggleOpen(r)}
                      labelOn={t('admin.toggleOpen')}
                      labelOff={t('admin.toggleClosed')}
                      color="green"
                    />
                  </div>
                  <div>
                    <ToggleBtn
                      checked={r.is_active}
                      onChange={() => toggleActive(r)}
                      labelOn={t('admin.toggleActive')}
                      labelOff={t('admin.toggleInactive')}
                      color="orange"
                    />
                  </div>
                  <div>
                    <a
                      href={`/restaurant/${r.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-gray-400 hover:text-orange-500 transition-colors"
                      title="View menu"
                    >
                      ↗
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ToggleBtn({
  checked,
  onChange,
  labelOn,
  labelOff,
  color,
}: {
  checked: boolean
  onChange: () => void
  labelOn: string
  labelOff: string
  color: 'green' | 'orange'
}) {
  const on = color === 'green' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
  return (
    <button
      onClick={onChange}
      className={`text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${checked ? on : 'bg-gray-100 text-gray-500'}`}
    >
      {checked ? labelOn : labelOff}
    </button>
  )
}
