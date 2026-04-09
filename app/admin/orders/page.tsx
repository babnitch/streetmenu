'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { Order, Restaurant } from '@/types'

const STATUS_STYLES: Record<string, string> = {
  pending:   'bg-yellow-100 text-yellow-700',
  confirmed: 'bg-blue-100 text-blue-700',
  preparing: 'bg-orange-100 text-orange-700',
  ready:     'bg-teal-100 text-teal-700',
  completed: 'bg-gray-100 text-gray-500',
}

type OrderWithRestaurant = Order & { restaurants: { name: string; city: string } | null }

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<OrderWithRestaurant[]>([])
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [loading, setLoading] = useState(true)

  // Filters
  const [restaurantFilter, setRestaurantFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const fetchOrders = useCallback(async () => {
    let query = supabase
      .from('orders')
      .select('*, restaurants(name, city)')
      .order('created_at', { ascending: false })

    if (restaurantFilter !== 'all') query = query.eq('restaurant_id', restaurantFilter)
    if (statusFilter !== 'all') query = query.eq('status', statusFilter)
    if (dateFrom) query = query.gte('created_at', dateFrom + 'T00:00:00')
    if (dateTo) query = query.lte('created_at', dateTo + 'T23:59:59')

    const { data } = await query
    if (data) setOrders(data as OrderWithRestaurant[])
    setLoading(false)
  }, [restaurantFilter, statusFilter, dateFrom, dateTo])

  useEffect(() => {
    supabase.from('restaurants').select('id, name, city').order('name').then(({ data }) => {
      if (data) setRestaurants(data as Restaurant[])
    })
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchOrders()
  }, [fetchOrders])

  const totalRevenue = orders
    .filter(o => o.status !== 'completed' || true) // all orders
    .reduce((sum, o) => sum + Number(o.total_price), 0)

  const pendingCount = orders.filter(o => o.status === 'pending').length

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
        <p className="text-sm text-gray-500 mt-0.5">All orders across all restaurants</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Orders" value={orders.length.toString()} />
        <StatCard label="Pending" value={pendingCount.toString()} highlight={pendingCount > 0} />
        <StatCard
          label="Revenue"
          value={`CHF ${totalRevenue.toFixed(2)}`}
        />
        <StatCard
          label="Restaurants"
          value={new Set(orders.map(o => o.restaurant_id)).size.toString()}
        />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl shadow-sm p-4 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Restaurant</label>
          <select
            value={restaurantFilter}
            onChange={e => setRestaurantFilter(e.target.value)}
            className={SELECT}
          >
            <option value="all">All restaurants</option>
            {restaurants.map(r => (
              <option key={r.id} value={r.id}>{r.name} {r.city ? `(${r.city})` : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Status</label>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={SELECT}>
            <option value="all">All statuses</option>
            {['pending','confirmed','preparing','ready','completed'].map(s => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">From date</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={SELECT} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">To date</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={SELECT} />
        </div>
      </div>

      {/* Orders list */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3 animate-bounce">🍜</div>
          <p>Loading orders…</p>
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">📋</div>
          <p>No orders found</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {/* Desktop header */}
          <div className="hidden lg:grid grid-cols-[1.5fr_1.2fr_1fr_2fr_0.8fr_1fr] gap-4 px-5 py-3 border-b border-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <span>Restaurant</span>
            <span>Customer</span>
            <span>Phone</span>
            <span>Items</span>
            <span>Total</span>
            <span>Status / Time</span>
          </div>

          {orders.map((order, idx) => (
            <div
              key={order.id}
              className={`px-5 py-4 ${idx < orders.length - 1 ? 'border-b border-gray-50' : ''} hover:bg-orange-50/30 transition-colors`}
            >
              {/* Mobile layout */}
              <div className="lg:hidden space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">{order.restaurants?.name ?? '—'}</p>
                    <p className="text-xs text-gray-400">{order.restaurants?.city}</p>
                  </div>
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_STYLES[order.status]}`}>
                    {order.status}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-medium text-gray-800">{order.customer_name}</span>
                  <span className="text-gray-500">{order.customer_phone}</span>
                </div>
                <p className="text-sm text-gray-600">{formatItems(order.items)}</p>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-orange-500">CHF {Number(order.total_price).toFixed(2)}</span>
                  <span className="text-xs text-gray-400">{formatDate(order.created_at)}</span>
                </div>
              </div>

              {/* Desktop layout */}
              <div className="hidden lg:grid grid-cols-[1.5fr_1.2fr_1fr_2fr_0.8fr_1fr] gap-4 items-center">
                <div>
                  <p className="font-medium text-gray-900 text-sm truncate">{order.restaurants?.name ?? '—'}</p>
                  <p className="text-xs text-gray-400">{order.restaurants?.city}</p>
                </div>
                <p className="text-sm text-gray-800 truncate">{order.customer_name}</p>
                <p className="text-sm text-gray-600 font-mono text-xs">{order.customer_phone}</p>
                <p className="text-sm text-gray-600 truncate" title={formatItems(order.items)}>
                  {formatItems(order.items)}
                </p>
                <p className="font-bold text-orange-500 text-sm">CHF {Number(order.total_price).toFixed(2)}</p>
                <div>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLES[order.status]}`}>
                    {order.status}
                  </span>
                  <p className="text-xs text-gray-400 mt-1">{formatDate(order.created_at)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function formatItems(items: Order['items']): string {
  if (!Array.isArray(items) || items.length === 0) return '—'
  return items.map(i => `${i.quantity}× ${i.name}`).join(', ')
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

const SELECT = 'w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400 bg-white'

function StatCard({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl p-4 ${highlight ? 'bg-orange-500 text-white' : 'bg-white shadow-sm'}`}>
      <p className={`text-xs font-medium ${highlight ? 'text-orange-100' : 'text-gray-500'}`}>{label}</p>
      <p className={`text-xl font-bold mt-1 ${highlight ? 'text-white' : 'text-gray-900'}`}>{value}</p>
    </div>
  )
}
