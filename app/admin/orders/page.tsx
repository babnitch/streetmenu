'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { Order, Restaurant } from '@/types'
import { useLanguage } from '@/lib/languageContext'
import PaymentBadge from '@/components/PaymentBadge'

const STATUS_STYLES: Record<string, string> = {
  pending:   'bg-brand-light text-warning',
  confirmed: 'bg-brand-light text-brand-darker',
  preparing: 'bg-brand-light text-brand-darker',
  ready:     'bg-teal-100 text-teal-700',
  completed: 'bg-surface-muted text-ink-secondary',
}

type OrderWithRestaurant = Order & { restaurants: { name: string; city: string } | null }

export default function AdminOrdersPage() {
  const { t, locale } = useLanguage()
  const [orders, setOrders] = useState<OrderWithRestaurant[]>([])
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [loading, setLoading] = useState(true)

  const [restaurantFilter, setRestaurantFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [paymentFilter, setPaymentFilter] = useState<'all' | 'paid' | 'reservation' | 'pending' | 'failed'>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const fetchOrders = useCallback(async () => {
    let query = supabase
      .from('orders')
      .select('*, restaurants(name, city)')
      .order('created_at', { ascending: false })

    if (restaurantFilter !== 'all') query = query.eq('restaurant_id', restaurantFilter)
    if (statusFilter !== 'all') query = query.eq('status', statusFilter)
    if (paymentFilter === 'paid')        query = query.eq('payment_status', 'paid')
    else if (paymentFilter === 'pending') query = query.eq('payment_status', 'pending')
    else if (paymentFilter === 'failed')  query = query.eq('payment_status', 'failed')
    else if (paymentFilter === 'reservation') query = query.eq('order_type', 'reservation')
    if (dateFrom) query = query.gte('created_at', dateFrom + 'T00:00:00')
    if (dateTo) query = query.lte('created_at', dateTo + 'T23:59:59')

    const { data } = await query
    if (data) setOrders(data as OrderWithRestaurant[])
    setLoading(false)
  }, [restaurantFilter, statusFilter, paymentFilter, dateFrom, dateTo])

  useEffect(() => {
    supabase.from('restaurants').select('id, name, city').order('name').then(({ data }) => {
      if (data) setRestaurants(data as Restaurant[])
    })
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchOrders()
  }, [fetchOrders])

  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.total_price), 0)
  const pendingCount = orders.filter(o => o.status === 'pending').length

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-primary">{t('admin.ordTitle')}</h1>
        <p className="text-sm text-ink-secondary mt-0.5">{t('admin.ordSub')}</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label={t('admin.ordTotal')} value={orders.length.toString()} />
        <StatCard label={t('admin.ordPending')} value={pendingCount.toString()} highlight={pendingCount > 0} />
        <StatCard label={t('admin.ordRevenue')} value={`CHF ${totalRevenue.toFixed(2)}`} />
        <StatCard label={t('admin.ordRests')} value={new Set(orders.map(o => o.restaurant_id)).size.toString()} />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl shadow-sm p-4 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div>
          <label className="block text-xs text-ink-secondary mb-1">Restaurant</label>
          <select
            value={restaurantFilter}
            onChange={e => setRestaurantFilter(e.target.value)}
            className={SELECT}
          >
            <option value="all">{t('admin.ordAllRests')}</option>
            {restaurants.map(r => (
              <option key={r.id} value={r.id}>{r.name} {r.city ? `(${r.city})` : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-ink-secondary mb-1">Status</label>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={SELECT}>
            <option value="all">{t('admin.ordAllStatus')}</option>
            {(['pending','confirmed','preparing','ready','completed'] as const).map(s => (
              <option key={s} value={s}>{t(`status.${s}`)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-ink-secondary mb-1">{t('admin.ordFromDate')}</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={SELECT} />
        </div>
        <div>
          <label className="block text-xs text-ink-secondary mb-1">{t('admin.ordToDate')}</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={SELECT} />
        </div>
        <div>
          <label className="block text-xs text-ink-secondary mb-1">Paiement / Payment</label>
          <select value={paymentFilter} onChange={e => setPaymentFilter(e.target.value as typeof paymentFilter)} className={SELECT}>
            <option value="all">Tous / All</option>
            <option value="paid">Payé / Paid</option>
            <option value="pending">En attente / Pending</option>
            <option value="failed">Échoué / Failed</option>
            <option value="reservation">Réservations / Reservations</option>
          </select>
        </div>
      </div>

      {/* Orders list */}
      {loading ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3 animate-bounce">🍜</div>
          <p>{t('admin.ordLoading')}</p>
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3">📋</div>
          <p>{t('admin.ordNone')}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <div className="hidden lg:grid grid-cols-[1.5fr_1.2fr_1fr_2fr_0.8fr_1fr] gap-4 px-5 py-3 border-b border-divider text-xs font-semibold text-ink-secondary uppercase tracking-wide">
            <span>{t('admin.ordColRest')}</span>
            <span>{t('admin.ordColCustomer')}</span>
            <span>{t('admin.ordColPhone')}</span>
            <span>{t('admin.ordColItems')}</span>
            <span>{t('admin.ordColTotal')}</span>
            <span>{t('admin.ordColStatus')}</span>
          </div>

          {orders.map((order, idx) => (
            <div
              key={order.id}
              className={`px-5 py-4 ${idx < orders.length - 1 ? 'border-b border-divider' : ''} hover:bg-brand-light/30 transition-colors`}
            >
              {/* Mobile layout */}
              <div className="lg:hidden space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-ink-primary text-sm">{order.restaurants?.name ?? '—'}</p>
                    <p className="text-xs text-ink-tertiary">{order.restaurants?.city}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_STYLES[order.status]}`}>
                      {t(`status.${order.status}` as Parameters<typeof t>[0])}
                    </span>
                    <PaymentBadge order={order} locale={locale} />
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-medium text-ink-primary">{order.customer_name}</span>
                  <span className="text-ink-secondary">{order.customer_phone}</span>
                </div>
                <p className="text-sm text-ink-secondary">{formatItems(order.items)}</p>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-brand">CHF {Number(order.total_price).toFixed(2)}</span>
                  <span className="text-xs text-ink-tertiary">{formatDate(order.created_at)}</span>
                </div>
              </div>

              {/* Desktop layout */}
              <div className="hidden lg:grid grid-cols-[1.5fr_1.2fr_1fr_2fr_0.8fr_1fr] gap-4 items-center">
                <div>
                  <p className="font-medium text-ink-primary text-sm truncate">{order.restaurants?.name ?? '—'}</p>
                  <p className="text-xs text-ink-tertiary">{order.restaurants?.city}</p>
                </div>
                <p className="text-sm text-ink-primary truncate">{order.customer_name}</p>
                <p className="text-sm text-ink-secondary font-mono text-xs">{order.customer_phone}</p>
                <p className="text-sm text-ink-secondary truncate" title={formatItems(order.items)}>
                  {formatItems(order.items)}
                </p>
                <p className="font-bold text-brand text-sm">CHF {Number(order.total_price).toFixed(2)}</p>
                <div className="space-y-1">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLES[order.status]}`}>
                    {t(`status.${order.status}` as Parameters<typeof t>[0])}
                  </span>
                  <PaymentBadge order={order} locale={locale} />
                  <p className="text-xs text-ink-tertiary">{formatDate(order.created_at)}</p>
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
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

const SELECT = 'w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white'

function StatCard({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl p-4 ${highlight ? 'bg-brand text-white' : 'bg-white shadow-sm'}`}>
      <p className={`text-xs font-medium ${highlight ? 'text-brand-light' : 'text-ink-secondary'}`}>{label}</p>
      <p className={`text-xl font-bold mt-1 ${highlight ? 'text-white' : 'text-ink-primary'}`}>{value}</p>
    </div>
  )
}
