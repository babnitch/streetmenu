'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Restaurant, MenuItem, Order } from '@/types'

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  confirmed: 'bg-blue-100 text-blue-700',
  preparing: 'bg-orange-100 text-orange-700',
  ready: 'bg-green-100 text-green-700',
  completed: 'bg-gray-100 text-gray-600',
}

const STATUS_NEXT: Record<string, string> = {
  pending: 'confirmed',
  confirmed: 'preparing',
  preparing: 'ready',
  ready: 'completed',
}

export default function DashboardPage() {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [selectedRestaurant, setSelectedRestaurant] = useState<Restaurant | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [tab, setTab] = useState<'orders' | 'menu'>('orders')
  const [showItemForm, setShowItemForm] = useState(false)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    supabase.from('restaurants').select('*').then(({ data }) => {
      if (data) {
        setRestaurants(data)
        if (data.length > 0) setSelectedRestaurant(data[0])
      }
    })
  }, [])

  const fetchOrders = useCallback(async (restaurantId: string) => {
    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })
    if (data) setOrders(data)
  }, [])

  const fetchMenu = useCallback(async (restaurantId: string) => {
    const { data } = await supabase
      .from('menu_items')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })
    if (data) setMenuItems(data)
  }, [])

  useEffect(() => {
    if (!selectedRestaurant) return
    fetchOrders(selectedRestaurant.id)
    fetchMenu(selectedRestaurant.id)

    const channel = supabase
      .channel(`orders-${selectedRestaurant.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${selectedRestaurant.id}` }, () => {
        fetchOrders(selectedRestaurant.id)
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [selectedRestaurant, fetchOrders, fetchMenu])

  async function toggleOpen() {
    if (!selectedRestaurant) return
    const { data } = await supabase
      .from('restaurants')
      .update({ is_open: !selectedRestaurant.is_open })
      .eq('id', selectedRestaurant.id)
      .select()
      .single()
    if (data) {
      setSelectedRestaurant(data)
      setRestaurants(prev => prev.map(r => r.id === data.id ? data : r))
    }
  }

  async function updateOrderStatus(orderId: string, status: string) {
    await supabase.from('orders').update({ status }).eq('id', orderId)
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: status as Order['status'] } : o))
  }

  async function toggleItemAvailability(item: MenuItem) {
    await supabase.from('menu_items').update({ is_available: !item.is_available }).eq('id', item.id)
    setMenuItems(prev => prev.map(m => m.id === item.id ? { ...m, is_available: !m.is_available } : m))
  }

  async function deleteItem(id: string) {
    if (!confirm('Delete this item?')) return
    await supabase.from('menu_items').delete().eq('id', id)
    setMenuItems(prev => prev.filter(m => m.id !== id))
  }

  if (restaurants.length === 0) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-5xl mb-4">🏪</div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">No restaurants yet</h2>
          <p className="text-gray-500 mb-4">Add restaurants through Supabase to get started</p>
          <Link href="/" className="text-orange-500 underline">Back to map</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-orange-50">
      {/* Header */}
      <div className="bg-white shadow-sm px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-gray-500 hover:text-orange-500 transition-colors text-sm">← Map</Link>
          <h1 className="text-lg font-bold text-gray-900">Dashboard</h1>
        </div>
        {/* Restaurant selector */}
        {restaurants.length > 1 && (
          <select
            value={selectedRestaurant?.id}
            onChange={e => setSelectedRestaurant(restaurants.find(r => r.id === e.target.value) ?? null)}
            className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 outline-none focus:border-orange-400"
          >
            {restaurants.map(r => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        )}
      </div>

      {selectedRestaurant && (
        <div className="max-w-2xl mx-auto px-4 py-4">
          {/* Restaurant card */}
          <div className="bg-white rounded-2xl p-4 shadow-sm mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-gray-900">{selectedRestaurant.name}</h2>
              <p className="text-sm text-gray-500">{selectedRestaurant.address}</p>
            </div>
            <button
              onClick={toggleOpen}
              className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
                selectedRestaurant.is_open
                  ? 'bg-green-100 text-green-700 hover:bg-green-200'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {selectedRestaurant.is_open ? '🟢 Open' : '🔴 Closed'}
            </button>
          </div>

          {/* Tabs */}
          <div className="flex bg-white rounded-2xl p-1 shadow-sm mb-4">
            <button
              onClick={() => setTab('orders')}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${
                tab === 'orders' ? 'bg-orange-500 text-white' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Orders {orders.filter(o => o.status !== 'completed').length > 0 && (
                <span className="ml-1 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">
                  {orders.filter(o => o.status !== 'completed').length}
                </span>
              )}
            </button>
            <button
              onClick={() => setTab('menu')}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${
                tab === 'menu' ? 'bg-orange-500 text-white' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Menu
            </button>
          </div>

          {/* Orders Tab */}
          {tab === 'orders' && (
            <div className="space-y-3">
              {orders.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <div className="text-4xl mb-3">📋</div>
                  <p>No orders yet</p>
                </div>
              )}
              {orders.map(order => (
                <div key={order.id} className="bg-white rounded-2xl p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="font-semibold text-gray-900">{order.customer_name}</p>
                      <p className="text-sm text-gray-500">{order.customer_phone}</p>
                    </div>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_COLORS[order.status]}`}>
                      {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                    </span>
                  </div>
                  <div className="text-sm text-gray-600 mb-3">
                    {Array.isArray(order.items) && order.items.map((item: { name: string; quantity: number; price: number }, i: number) => (
                      <span key={i}>{item.quantity}× {item.name}{i < order.items.length - 1 ? ', ' : ''}</span>
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-orange-500">CHF {Number(order.total_price).toFixed(2)}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">{new Date(order.created_at).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}</span>
                      {STATUS_NEXT[order.status] && (
                        <button
                          onClick={() => updateOrderStatus(order.id, STATUS_NEXT[order.status])}
                          className="bg-orange-500 text-white text-xs px-3 py-1.5 rounded-full font-semibold hover:bg-orange-600 transition-colors"
                        >
                          → {STATUS_NEXT[order.status].charAt(0).toUpperCase() + STATUS_NEXT[order.status].slice(1)}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Menu Tab */}
          {tab === 'menu' && (
            <div>
              <button
                onClick={() => { setEditingItem(null); setShowItemForm(true) }}
                className="w-full bg-orange-500 text-white py-3 rounded-2xl font-semibold mb-4 hover:bg-orange-600 transition-colors"
              >
                + Add Menu Item
              </button>

              {showItemForm && (
                <MenuItemForm
                  restaurantId={selectedRestaurant.id}
                  item={editingItem}
                  onClose={() => { setShowItemForm(false); setEditingItem(null) }}
                  onSave={() => { fetchMenu(selectedRestaurant.id); setShowItemForm(false); setEditingItem(null) }}
                  uploading={uploading}
                  setUploading={setUploading}
                />
              )}

              <div className="space-y-3">
                {menuItems.length === 0 && !showItemForm && (
                  <div className="text-center py-12 text-gray-400">
                    <div className="text-4xl mb-3">🍽️</div>
                    <p>No menu items yet</p>
                  </div>
                )}
                {menuItems.map(item => (
                  <div key={item.id} className="bg-white rounded-2xl p-3 shadow-sm flex items-center gap-3">
                    {item.photo_url ? (
                      <div className="relative w-14 h-14 rounded-xl overflow-hidden flex-shrink-0">
                        <Image src={item.photo_url} alt={item.name} fill className="object-cover" />
                      </div>
                    ) : (
                      <div className="w-14 h-14 rounded-xl bg-orange-50 flex items-center justify-center text-2xl flex-shrink-0">🍽️</div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-gray-900 text-sm truncate">{item.name}</p>
                        {item.is_daily_special && <span className="text-xs bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full">Special</span>}
                      </div>
                      <p className="text-orange-500 text-sm font-semibold">CHF {item.price.toFixed(2)}</p>
                      <p className="text-xs text-gray-400">{item.category}</p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <button
                        onClick={() => toggleItemAvailability(item)}
                        className={`text-xs px-2 py-1 rounded-full font-medium ${
                          item.is_available ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {item.is_available ? 'Available' : 'Hidden'}
                      </button>
                      <div className="flex gap-1">
                        <button
                          onClick={() => { setEditingItem(item); setShowItemForm(true) }}
                          className="text-xs text-blue-500 hover:text-blue-700"
                        >
                          Edit
                        </button>
                        <span className="text-gray-300">·</span>
                        <button
                          onClick={() => deleteItem(item.id)}
                          className="text-xs text-red-400 hover:text-red-600"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MenuItemForm({
  restaurantId,
  item,
  onClose,
  onSave,
  uploading,
  setUploading,
}: {
  restaurantId: string
  item: MenuItem | null
  onClose: () => void
  onSave: () => void
  uploading: boolean
  setUploading: (v: boolean) => void
}) {
  const [name, setName] = useState(item?.name ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [price, setPrice] = useState(item?.price?.toString() ?? '')
  const [category, setCategory] = useState(item?.category ?? '')
  const [photoUrl, setPhotoUrl] = useState(item?.photo_url ?? '')
  const [isAvailable, setIsAvailable] = useState(item?.is_available ?? true)
  const [isSpecial, setIsSpecial] = useState(item?.is_daily_special ?? false)
  const [saving, setSaving] = useState(false)

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const path = `menu-items/${Date.now()}-${file.name}`
    const { error } = await supabase.storage.from('photos').upload(path, file)
    if (!error) {
      const { data } = supabase.storage.from('photos').getPublicUrl(path)
      setPhotoUrl(data.publicUrl)
    }
    setUploading(false)
  }

  async function handleSave() {
    setSaving(true)
    const payload = {
      restaurant_id: restaurantId,
      name: name.trim(),
      description: description.trim(),
      price: parseFloat(price),
      category: category.trim(),
      photo_url: photoUrl,
      is_available: isAvailable,
      is_daily_special: isSpecial,
    }

    if (item) {
      await supabase.from('menu_items').update(payload).eq('id', item.id)
    } else {
      await supabase.from('menu_items').insert(payload)
    }
    setSaving(false)
    onSave()
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-gray-900">{item ? 'Edit Item' : 'New Item'}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
      </div>

      <div className="space-y-3">
        <input
          placeholder="Item name *"
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
        />
        <textarea
          placeholder="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={2}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400 resize-none"
        />
        <div className="flex gap-2">
          <input
            placeholder="Price (CHF) *"
            type="number"
            step="0.50"
            value={price}
            onChange={e => setPrice(e.target.value)}
            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
          />
          <input
            placeholder="Category"
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
          />
        </div>

        {/* Photo upload */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Photo</label>
          <input type="file" accept="image/*" onChange={handlePhotoUpload} className="text-xs text-gray-600" />
          {uploading && <p className="text-xs text-orange-500 mt-1">Uploading...</p>}
          {photoUrl && !uploading && (
            <div className="relative w-20 h-20 rounded-xl overflow-hidden mt-2">
              <Image src={photoUrl} alt="preview" fill className="object-cover" />
            </div>
          )}
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={isAvailable} onChange={e => setIsAvailable(e.target.checked)} className="accent-orange-500" />
            Available
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={isSpecial} onChange={e => setIsSpecial(e.target.checked)} className="accent-orange-500" />
            Daily Special
          </label>
        </div>

        <button
          onClick={handleSave}
          disabled={saving || !name || !price || uploading}
          className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
        >
          {saving ? 'Saving...' : item ? 'Save Changes' : 'Add Item'}
        </button>
      </div>
    </div>
  )
}
