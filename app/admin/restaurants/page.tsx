'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Restaurant } from '@/types'

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

export default function AdminRestaurantsPage() {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<RestaurantForm>(EMPTY_FORM)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [cityFilter, setCityFilter] = useState('all')

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

  const cities = ['all', ...Array.from(new Set(restaurants.map(r => r.city).filter(Boolean)))]

  const filtered = restaurants.filter(r => {
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
          <h1 className="text-2xl font-bold text-gray-900">Restaurants</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {restaurants.filter(r => r.is_active).length} active · {restaurants.length} total
          </p>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="bg-orange-500 hover:bg-orange-600 text-white px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors"
        >
          {showForm ? '✕ Cancel' : '+ Add Restaurant'}
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="bg-white rounded-2xl shadow-sm border border-orange-100 p-6 mb-6">
          <h2 className="font-bold text-gray-900 mb-4">New Restaurant</h2>
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
              {saving ? 'Saving…' : 'Add Restaurant'}
            </button>
            <button onClick={() => setShowForm(false)} className="text-sm text-gray-500 hover:text-gray-700 px-4">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, city, address…"
          className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-orange-400"
        />
        <select
          value={cityFilter}
          onChange={e => setCityFilter(e.target.value)}
          className="border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-orange-400 bg-white"
        >
          {cities.map(c => (
            <option key={c} value={c}>{c === 'all' ? 'All cities' : c}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3 animate-bounce">🍜</div>
          <p>Loading restaurants…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">🏪</div>
          <p>No restaurants found</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {/* Desktop table header */}
          <div className="hidden sm:grid grid-cols-[2fr_1fr_1.5fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <span>Restaurant</span>
            <span>City</span>
            <span>WhatsApp</span>
            <span>Open Now</span>
            <span>Active</span>
            <span></span>
          </div>

          {filtered.map((r, idx) => (
            <div
              key={r.id}
              className={`flex flex-col sm:grid sm:grid-cols-[2fr_1fr_1.5fr_1fr_1fr_auto] sm:items-center gap-2 sm:gap-4 px-5 py-4 ${
                idx < filtered.length - 1 ? 'border-b border-gray-50' : ''
              } ${!r.is_active ? 'opacity-60' : ''}`}
            >
              {/* Name + logo */}
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

              {/* City */}
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-gray-600">{r.city || '—'}</span>
              </div>

              {/* WhatsApp */}
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

              {/* Open toggle */}
              <div>
                <Toggle
                  checked={r.is_open}
                  onChange={() => toggleOpen(r)}
                  labelOn="Open"
                  labelOff="Closed"
                  color="green"
                />
              </div>

              {/* Active toggle */}
              <div>
                <Toggle
                  checked={r.is_active}
                  onChange={() => toggleActive(r)}
                  labelOn="Active"
                  labelOff="Inactive"
                  color="orange"
                />
              </div>

              {/* Link to dashboard */}
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
    </div>
  )
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

function Toggle({
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
  const on = color === 'green'
    ? 'bg-green-100 text-green-700'
    : 'bg-orange-100 text-orange-700'
  const off = 'bg-gray-100 text-gray-500'

  return (
    <button
      onClick={onChange}
      className={`text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${checked ? on : off}`}
    >
      {checked ? labelOn : labelOff}
    </button>
  )
}
