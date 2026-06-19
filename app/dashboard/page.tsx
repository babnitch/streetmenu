'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Restaurant, MenuItem, Order } from '@/types'
import { useLanguage, useBi, pickBi } from '@/lib/languageContext'
import { isPercentDiscount } from '@/lib/vouchers'
import {
  validatePrepTime,
  formatPrepTime,
  PREP_TIME_DEFAULT_MIN,
  PREP_TIME_DEFAULT_MAX,
} from '@/lib/prepTime'
import { useMode, type DashboardTab } from '@/lib/modeContext'
import TopNav from '@/components/TopNav'
import PaymentBadge from '@/components/PaymentBadge'
import PhoneInput from '@/components/PhoneInput'
import { getCountryFromCity } from '@/lib/phoneValidation'
import { normalizeMode, modeFromLegacy, canPayOnline, type PaymentMode } from '@/lib/paymentMode'

type VendorRole = 'owner' | 'manager' | 'staff' | 'admin'
type TargetStatus = 'confirmed' | 'preparing' | 'ready' | 'delivered' | 'cancelled'
type OrderFilter = 'pending' | 'active' | 'completed' | 'all'

const STATUS_COLORS: Record<string, string> = {
  pending:   'bg-brand-light text-warning',
  confirmed: 'bg-brand-light text-brand-darker',
  preparing: 'bg-brand-light text-brand-darker',
  ready:     'bg-brand-light text-brand-darker',
  delivered: 'bg-surface-muted text-ink-secondary',
  completed: 'bg-surface-muted text-ink-secondary',   // legacy alias
  cancelled: 'bg-brand-light text-danger',
}

const STATUS_LABEL: Record<string, string> = {
  pending: '⏳ En attente / Pending',
  confirmed: '✅ Confirmée / Confirmed',
  preparing: '🍳 En préparation / Preparing',
  ready: '🎉 Prête / Ready',
  delivered: '✅ Livrée / Delivered',
  completed: '✅ Terminée / Completed',     // legacy
  cancelled: '❌ Annulée / Cancelled',
}

// Buttons visible per current status, and which roles can press each.
interface ActionButton {
  label: string
  target: TargetStatus
  roles: Array<'owner' | 'manager' | 'staff'>
  destructive?: boolean
}
const STATUS_ACTIONS: Record<string, ActionButton[]> = {
  pending: [
    { label: '✅ Confirmer / Confirm',                target: 'confirmed', roles: ['owner', 'manager'] },
    { label: '❌ Annuler / Cancel',                    target: 'cancelled', roles: ['owner', 'manager'], destructive: true },
  ],
  confirmed: [
    { label: '🍳 En préparation / Start preparing',   target: 'preparing', roles: ['owner', 'manager'] },
    { label: '❌ Annuler / Cancel',                    target: 'cancelled', roles: ['owner', 'manager'], destructive: true },
  ],
  preparing: [
    { label: '🎉 Prêt / Ready for pickup',            target: 'ready',     roles: ['owner', 'manager', 'staff'] },
    { label: '❌ Annuler / Cancel',                    target: 'cancelled', roles: ['owner', 'manager'], destructive: true },
  ],
  ready: [
    { label: '📦 Récupéré / Picked up',               target: 'delivered', roles: ['owner', 'manager', 'staff'] },
  ],
  delivered: [],
  completed: [],
  cancelled: [],
}

const FILTER_LABEL: Record<OrderFilter, string> = {
  pending: 'En attente / Pending',
  active: 'En cours / Active',
  completed: 'Terminées / Completed',
  all: 'Toutes / All',
}
const FILTER_STATUSES: Record<OrderFilter, string[] | null> = {
  pending:   ['pending'],
  active:    ['confirmed', 'preparing', 'ready'],
  completed: ['delivered', 'completed', 'cancelled'],
  all:       null,
}

function orderShortId(id: string): string {
  return id.replace(/-/g, '').slice(-4).toUpperCase()
}

function buildWhatsappHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '').replace(/^\+/, '')
  return `https://wa.me/${digits}`
}

function playNewOrderBeep() {
  try {
    const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctx = W.AudioContext ?? W.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.connect(g); g.connect(ctx.destination)
    o.type = 'sine'; o.frequency.value = 880
    g.gain.setValueAtTime(0.12, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
    o.start(); o.stop(ctx.currentTime + 0.4)
  } catch { /* autoplay restrictions — silent fail */ }
}

interface SessionUser { id: string; name: string; role: string }

export default function DashboardPage() {
  const bi = useBi()
  const { t, locale } = useLanguage()
  const router = useRouter()
  const [me, setMe] = useState<SessionUser | null>(null)
  const [loadingAuth, setLoadingAuth] = useState(true)
  const [effectiveRole, setEffectiveRole] = useState<VendorRole | null>(null)
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [selectedRestaurant, setSelectedRestaurant] = useState<Restaurant | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  // `team` + `settings` land via the Restaurant-mode TopNav/BottomNav. Full
  // UI for them arrives in a follow-up; for now they show a stub so the
  // tab bar has something sensible to display instead of the default.
  //
  // Tab state lives in ModeContext so BottomNav/TopNav can flip tabs
  // without a route change — encoding it in ?tab= led to missed taps
  // because Next.js skips re-render when only the query string moves.
  const { dashboardTab: tab, setDashboardTab: setTab } = useMode()

  // Honor the ?tab= query param so deep links from the nav land on the
  // requested tab. Only accept known tab values to avoid arbitrary strings.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const q = new URLSearchParams(window.location.search).get('tab')
    const allowed: DashboardTab[] = ['orders', 'menu', 'validate', 'vouchers', 'team', 'settings']
    if (q && (allowed as string[]).includes(q)) {
      setTab(q as DashboardTab)
    }
  }, [setTab])
  const [validateInput, setValidateInput] = useState('')
  const [validating, setValidating] = useState(false)
  const [validateResult, setValidateResult] = useState<null | 'ok' | 'used' | 'invalid'>(null)
  const [validateDetails, setValidateDetails] = useState<{ code: string; discount: string; cvId: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [validateDone, setValidateDone] = useState(false)
  const [showItemForm, setShowItemForm] = useState(false)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  const [uploading, setUploading] = useState(false)

  // Order management state
  const [orderFilter, setOrderFilter] = useState<OrderFilter>('pending')
  const [newOrderFlash, setNewOrderFlash] = useState(false)
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string>('')
  const lastSeenPendingRef = useRef<string | null | undefined>(undefined)

  // Manual "mark as paid" modal — covers cash, MTN MoMo, Orange Money.
  // PawaPay-paid orders are excluded at the trigger site (payment_id != null).
  type ManualMethod = 'cash' | 'mtn_momo' | 'orange_money'
  const [markPaidOrder, setMarkPaidOrder] = useState<Order | null>(null)
  const [markPaidMethod, setMarkPaidMethod] = useState<ManualMethod>('cash')
  const [markPaidPhone, setMarkPaidPhone] = useState('')
  const [markPaidSubmitting, setMarkPaidSubmitting] = useState(false)
  const [markPaidError, setMarkPaidError] = useState('')

  function openMarkPaid(order: Order) {
    setMarkPaidOrder(order)
    setMarkPaidMethod('cash')
    setMarkPaidPhone('')
    setMarkPaidError('')
  }
  function closeMarkPaid() {
    if (markPaidSubmitting) return
    setMarkPaidOrder(null)
    setMarkPaidError('')
  }
  async function confirmMarkPaid() {
    if (!markPaidOrder) return
    const needsPhone = markPaidMethod !== 'cash'
    if (needsPhone && !markPaidPhone.trim()) {
      setMarkPaidError(bi('Numéro requis', 'Phone number required'))
      return
    }
    setMarkPaidSubmitting(true)
    setMarkPaidError('')
    try {
      const res = await fetch(`/api/orders/${markPaidOrder.id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method:      markPaidMethod,
          payer_phone: needsPhone ? markPaidPhone.trim() : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMarkPaidError(data.error ?? bi('Erreur', 'Error'))
        return
      }
      setOrders(prev => prev.map(o => o.id === markPaidOrder.id ? {
        ...o,
        payment_status: 'paid' as Order['payment_status'],
        payment_method: markPaidMethod,
        manual_payment_phone: needsPhone ? markPaidPhone.trim() : null,
      } : o))
      setMarkPaidOrder(null)
    } catch (e) {
      setMarkPaidError((e as Error).message)
    } finally {
      setMarkPaidSubmitting(false)
    }
  }

  // Auth on mount
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        if (!data?.user) { router.push('/account'); return }
        setMe(data.user)
      })
      .catch(() => router.push('/account'))
      .finally(() => { if (!cancelled) setLoadingAuth(false) })
    return () => { cancelled = true }
  }, [router])

  // Map of restaurant.id → role, populated from the server. Admins get no
  // map (role resolution short-circuits to 'admin').
  const [rolesByRestaurantId, setRolesByRestaurantId] = useState<Record<string, VendorRole>>({})

  // Scope restaurants. Routed through /api/vendor/restaurants (uses
  // supabaseAdmin) rather than an anon query because RLS blocks anon reads
  // of restaurant_team. The server also merges restaurants.customer_id
  // (implicit owner) into the result, so owners without explicit team
  // rows still see their restaurant here.
  useEffect(() => {
    if (!me) return
    const isAdmin = ['super_admin', 'admin', 'moderator'].includes(me.role)
    if (isAdmin) {
      // Admins see every non-deleted restaurant.
      supabase.from('restaurants').select('*')
        .is('deleted_at', null).neq('status', 'deleted')
        .order('created_at', { ascending: false })
        .then(({ data }) => {
          if (data) {
            setRestaurants(data)
            setSelectedRestaurant(prev => prev ?? data[0] ?? null)
          }
        })
      return
    }
    fetch('/api/vendor/restaurants', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        const list = (data?.restaurants ?? []) as Restaurant[]
        const rolesMap = (data?.rolesByRestaurantId ?? {}) as Record<string, VendorRole>
        console.log('[dashboard] me=', me.id.slice(0, 8), 'restaurants=', list.length, 'roles=', rolesMap)
        // One-line open/closed snapshot so a vendor reporting "we're open but
        // it shows closed" can verify the actual DB value in devtools.
        // Includes id + is_active + status so we can compare against the
        // public /restaurant/[id] page, which reads the same fields.
        for (const r of list) {
          console.log('[dashboard] loaded',
            'id=', r.id,
            'name=', r.name,
            'is_open=', r.is_open,
            'is_active=', r.is_active,
            'status=', r.status)
        }
        setRestaurants(list)
        setRolesByRestaurantId(rolesMap)
        setSelectedRestaurant(prev => prev ?? list[0] ?? null)
      })
      .catch(e => console.error('[dashboard] vendor/restaurants fetch failed:', (e as Error).message))
  }, [me])

  // Resolve this session's role for the currently-selected restaurant.
  // For customers, use the server-provided map; for admins, short-circuit.
  useEffect(() => {
    if (!me || !selectedRestaurant) { setEffectiveRole(null); return }
    if (['super_admin', 'admin', 'moderator'].includes(me.role)) {
      setEffectiveRole('admin')
      return
    }
    const role = rolesByRestaurantId[selectedRestaurant.id] ?? null
    console.log('[dashboard] selectedRestaurant=', selectedRestaurant.id.slice(0, 8), 'role=', role)
    setEffectiveRole(role)
  }, [me, selectedRestaurant, rolesByRestaurantId])

  const fetchOrders = useCallback(async (restaurantId: string) => {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })
    console.log('[dashboard] fetchOrders restaurant=', restaurantId.slice(0, 8), 'count=', data?.length, 'error=', error)
    if (!data) return
    setOrders(data)

    // New-order detection: if the newest pending id changed (and it's not the
    // initial load), flash + beep. Tracked in a ref so we don't need to add
    // it to fetchOrders' dep array.
    const newestPending = data.find(o => o.status === 'pending')?.id ?? null
    if (lastSeenPendingRef.current === undefined) {
      lastSeenPendingRef.current = newestPending
    } else if (newestPending && newestPending !== lastSeenPendingRef.current) {
      playNewOrderBeep()
      setNewOrderFlash(true)
      setTimeout(() => setNewOrderFlash(false), 4000)
      lastSeenPendingRef.current = newestPending
    } else if (!newestPending) {
      lastSeenPendingRef.current = null
    }
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
    const next = !selectedRestaurant.is_open
    const { data, error } = await supabase
      .from('restaurants')
      .update({ is_open: next })
      .eq('id', selectedRestaurant.id)
      .select()
      .single()
    console.log('[dashboard] toggleOpen', selectedRestaurant.name, 'from=', selectedRestaurant.is_open, 'to=', next, 'returned=', data?.is_open, 'error=', error)
    if (error) {
      setUpdateError(error.message)
      return
    }
    if (data) {
      setSelectedRestaurant(data)
      setRestaurants(prev => prev.map(r => r.id === data.id ? data : r))
    }
  }

  async function updateOrderStatus(orderId: string, status: TargetStatus) {
    setUpdatingOrderId(orderId)
    setUpdateError('')
    try {
      const res = await fetch(`/api/orders/${orderId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const data = await res.json()
      if (!res.ok) {
        setUpdateError(data.error ?? bi('Erreur', 'Error'))
        return
      }
      setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: status as Order['status'] } : o))
    } catch (e) {
      setUpdateError((e as Error).message)
    } finally {
      setUpdatingOrderId(null)
    }
  }

  async function toggleItemAvailability(item: MenuItem) {
    await supabase.from('menu_items').update({ is_available: !item.is_available }).eq('id', item.id)
    setMenuItems(prev => prev.map(m => m.id === item.id ? { ...m, is_available: !m.is_available } : m))
  }

  async function deleteItem(id: string) {
    if (!confirm(t('dash.deleteConfirm'))) return
    await supabase.from('menu_items').delete().eq('id', id)
    setMenuItems(prev => prev.filter(m => m.id !== id))
  }

  if (loadingAuth || !me) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center px-4">
        <div className="text-3xl animate-pulse text-ink-tertiary">…</div>
      </div>
    )
  }

  if (restaurants.length === 0) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-5xl mb-4">🏪</div>
          <h2 className="text-xl font-bold text-ink-primary mb-2">{t('dash.noRest')}</h2>
          <p className="text-ink-secondary mb-4">{t('dash.noRestSub')}</p>
          <Link href="/" className="text-brand underline">{t('dash.backToMap')}</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface-muted">
      {/* Global nav stays sticky on every dashboard tab — in restaurant
          mode the TopNav surfaces the Orders/Menu/Vouchers/Team links
          that drive tab state via ModeContext. */}
      <TopNav />

      {/* Sub-header only renders when a vendor owns/manages multiple
          restaurants; a single-restaurant vendor has nothing to pick
          and the whole row would just be empty chrome. */}
      {restaurants.length > 1 && (
        <div className="bg-surface border-b border-divider">
          <div className="max-w-2xl mx-auto px-4 py-2 flex items-center justify-end gap-2">
            <select
              value={selectedRestaurant?.id}
              onChange={e => setSelectedRestaurant(restaurants.find(r => r.id === e.target.value) ?? null)}
              className="text-sm border border-divider rounded-xl px-3 py-1.5 outline-none focus:border-brand max-w-[60vw]"
            >
              {restaurants.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {selectedRestaurant && (
        <div className="max-w-2xl mx-auto px-4 py-4 pb-20 md:pb-4">
          {/* Restaurant card */}
          <div className="bg-white rounded-2xl p-4 shadow-sm mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-ink-primary">{selectedRestaurant.name}</h2>
              <p className="text-sm text-ink-secondary">{selectedRestaurant.address}</p>
            </div>
            <button
              onClick={toggleOpen}
              className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors border ${
                selectedRestaurant.is_open
                  ? 'bg-white border-green-200 text-green-600 hover:bg-green-50'
                  : 'bg-white border-red-200 text-red-600 hover:bg-red-50'
              }`}
            >
              {selectedRestaurant.is_open ? t('dash.openBtn') : t('dash.closedBtn')}
            </button>
          </div>

          {/* Inline tab bar removed — tab switching lives in the TopNav
              (desktop) and BottomNav (mobile). Rendering it here as well
              was triplicate navigation and still forced the user's eye
              to move twice per tab change. */}

          {/* Orders Tab */}
          {tab === 'orders' && (
            <div>
              {newOrderFlash && (
                <div className="bg-brand text-white rounded-2xl px-4 py-3 mb-3 text-sm font-semibold shadow-lg animate-pulse">
                  🔔 {bi('Nouvelle commande!', 'New order!')}
                </div>
              )}
              {selectedRestaurant && (
                <VendorRatingsPanel restaurantId={selectedRestaurant.id} />
              )}

              {/* Filter bar with counts */}
              <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
                {(['pending', 'active', 'completed', 'all'] as OrderFilter[]).map(f => {
                  const statuses = FILTER_STATUSES[f]
                  const count = statuses === null ? orders.length : orders.filter(o => statuses.includes(o.status)).length
                  const active = orderFilter === f
                  return (
                    <button
                      key={f}
                      onClick={() => setOrderFilter(f)}
                      className={`flex-shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors ${
                        active ? 'bg-ink-primary text-white' : 'bg-white text-ink-secondary shadow-sm hover:text-ink-primary'
                      }`}
                    >
                      {pickBi(FILTER_LABEL[f], locale)} ({count})
                    </button>
                  )
                })}
              </div>

              {updateError && (
                <div className="bg-brand-light border border-divider text-danger text-xs rounded-xl px-3 py-2 mb-3">
                  {updateError}
                </div>
              )}

              {/* Filtered list */}
              {(() => {
                const statuses = FILTER_STATUSES[orderFilter]
                const visible = statuses === null ? orders : orders.filter(o => statuses.includes(o.status))
                if (visible.length === 0) {
                  return (
                    <div className="text-center py-12 text-ink-tertiary">
                      <div className="text-4xl mb-3">📋</div>
                      <p className="text-sm">{bi('Aucune commande', 'No orders')}</p>
                    </div>
                  )
                }
                return (
                  <div className="space-y-3">
                    {visible.map(order => {
                      const id4 = orderShortId(order.id)
                      const created = new Date(order.created_at)
                      const dateStr = created.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
                      const timeStr = created.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

                      // Payment gate. A paid_order can't move forward until
                      // PawaPay confirms the deposit. Failed payments freeze
                      // the order entirely — only the customer can unstick
                      // it (by retrying payment), so we expose no actions.
                      const isPaidOrder = order.order_type === 'paid_order'
                      const paymentPending = isPaidOrder && order.payment_status === 'pending'
                      const paymentFailed  = isPaidOrder && order.payment_status === 'failed'

                      // "Mark as paid" eligibility — anything that hasn't
                      // been settled through PawaPay yet. A non-null
                      // payment_id means the order went through the in-app
                      // deposit flow, so we never offer the manual override.
                      const canMarkPaid =
                        !order.payment_id
                        && order.payment_status !== 'paid'
                        && (effectiveRole === 'admin' || effectiveRole === 'owner' || effectiveRole === 'manager')

                      const roleFiltered = (STATUS_ACTIONS[order.status] ?? [])
                        .filter(a => effectiveRole === 'admin' || (effectiveRole && a.roles.includes(effectiveRole as 'owner' | 'manager' | 'staff')))
                      const actions = paymentFailed
                        ? []
                        : paymentPending
                          ? roleFiltered.filter(a => a.target === 'cancelled')
                          : roleFiltered
                      return (
                        <div key={order.id} className="bg-white rounded-2xl p-4 shadow-sm">
                          <div className="flex items-start justify-between mb-2 gap-3 flex-wrap">
                            <div className="min-w-0">
                              <p className="font-semibold text-ink-primary">
                                {order.customer_name}
                                <span className="ml-2 text-ink-tertiary font-mono text-xs">#{id4}</span>
                              </p>
                              {order.customer_phone ? (
                                <a
                                  href={buildWhatsappHref(order.customer_phone)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sm text-brand-darker hover:text-brand-darker transition-colors font-mono"
                                >
                                  📱 {order.customer_phone}
                                </a>
                              ) : (
                                <p className="text-sm text-ink-tertiary">—</p>
                              )}
                              <p className="text-xs text-ink-tertiary mt-0.5">{dateStr} · {timeStr}</p>
                            </div>
                            <div className="flex flex-col items-end gap-1 flex-shrink-0">
                              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_COLORS[order.status] ?? 'bg-surface-muted text-ink-secondary'}`}>
                                {pickBi(STATUS_LABEL[order.status] ?? order.status, locale)}
                              </span>
                              <PaymentBadge order={order} locale={locale} />
                            </div>
                          </div>

                          <ul className="text-sm text-ink-primary space-y-0.5 mb-3">
                            {Array.isArray(order.items) && order.items.map((item: { name: string; quantity: number; price: number }, i: number) => (
                              <li key={i} className="flex items-center justify-between">
                                <span>{item.quantity}× {item.name}</span>
                                <span className="text-ink-secondary font-mono text-xs">{(item.quantity * item.price).toLocaleString()} FCFA</span>
                              </li>
                            ))}
                          </ul>

                          <div className="flex items-center justify-between gap-2 flex-wrap pt-2 border-t border-divider">
                            <span className="font-bold text-brand">{Number(order.total_price).toLocaleString()} FCFA</span>
                            <div className="flex items-center gap-2 flex-wrap">
                              {paymentPending && (
                                <span className="text-xs font-semibold px-3 py-1.5 rounded-full bg-brand-light text-warning">
                                  {bi('⏳ En attente de paiement', '⏳ Waiting for payment')}
                                </span>
                              )}
                              {paymentFailed && (
                                <span className="text-xs font-semibold px-3 py-1.5 rounded-full bg-brand-light text-danger">
                                  {bi('❌ Paiement échoué', '❌ Payment failed')}
                                </span>
                              )}
                              {!paymentPending && !paymentFailed && actions.length === 0 && !canMarkPaid && (
                                <span className="text-xs text-ink-tertiary">— / —</span>
                              )}
                              {canMarkPaid && (
                                <button
                                  onClick={() => openMarkPaid(order)}
                                  disabled={updatingOrderId === order.id}
                                  className="text-xs px-3 py-1.5 rounded-full font-semibold transition-colors bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                                >
                                  💰 {bi('Marquer payé', 'Mark as paid')}
                                </button>
                              )}
                              {actions.map(a => (
                                <button
                                  key={a.target}
                                  onClick={() => updateOrderStatus(order.id, a.target)}
                                  disabled={updatingOrderId === order.id}
                                  className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors disabled:opacity-50 ${
                                    a.destructive
                                      ? 'bg-brand-light text-danger border border-divider hover:bg-brand-light'
                                      : 'bg-brand text-white hover:bg-brand-dark'
                                  }`}
                                >
                                  {updatingOrderId === order.id ? '…' : pickBi(a.label, locale)}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </div>
          )}

          {/* Validate Tab */}
          {tab === 'validate' && (
            <div className="bg-white rounded-2xl shadow-sm p-5">
              <button
                onClick={() => setTab('vouchers')}
                className="text-xs text-brand hover:text-brand-dark font-semibold mb-3"
              >
                ← {bi('Retour aux bons', 'Back to vouchers')}
              </button>
              <h3 className="font-bold text-ink-primary mb-4">{t('dash.validateTitle')}</h3>
              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  value={validateInput}
                  onChange={e => { setValidateInput(e.target.value); setValidateResult(null); setValidateDetails(null); setValidateDone(false) }}
                  placeholder={t('dash.validateInputPh')}
                  className="flex-1 border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
                />
                <button
                  onClick={async () => {
                    const input = validateInput.trim()
                    if (!input) return
                    setValidating(true)
                    setValidateResult(null)
                    setValidateDetails(null)
                    setValidateDone(false)

                    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)
                    if (isUuid) {
                      const { data } = await supabase
                        .from('customer_vouchers')
                        .select('*, vouchers(*)')
                        .eq('id', input)
                        .maybeSingle()
                      if (!data) { setValidateResult('invalid') }
                      else if (data.used_at) { setValidateResult('used') }
                      else {
                        const v = data.vouchers
                        setValidateResult('ok')
                        setValidateDetails({
                          code: v?.code ?? '',
                          discount: isPercentDiscount(v?.discount_type) ? `-${v?.discount_value}%` : `-${Number(v?.discount_value).toLocaleString()} FCFA`,
                          cvId: data.id,
                        })
                      }
                    } else {
                      const { data } = await supabase
                        .from('customer_vouchers')
                        .select('*, vouchers(*)')
                        .eq('vouchers.code', input.toUpperCase())
                        .is('used_at', null)
                        .order('claimed_at', { ascending: false })
                        .limit(1)
                        .maybeSingle()
                      if (!data || !data.vouchers) { setValidateResult('invalid') }
                      else {
                        const v = data.vouchers
                        setValidateResult('ok')
                        setValidateDetails({
                          code: v?.code ?? '',
                          discount: isPercentDiscount(v?.discount_type) ? `-${v?.discount_value}%` : `-${Number(v?.discount_value).toLocaleString()} FCFA`,
                          cvId: data.id,
                        })
                      }
                    }
                    setValidating(false)
                  }}
                  disabled={validating || !validateInput.trim()}
                  className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
                >
                  {validating ? t('dash.validating') : t('dash.validateBtn')}
                </button>
              </div>

              {validateResult === 'invalid' && (
                <div className="bg-brand-light rounded-xl p-4 text-center">
                  <p className="text-danger font-semibold">❌ {t('dash.validateInvalid')}</p>
                </div>
              )}
              {validateResult === 'used' && (
                <div className="bg-surface-muted rounded-xl p-4 text-center">
                  <p className="text-ink-secondary font-semibold">⚠️ {t('dash.validateUsed')}</p>
                </div>
              )}
              {validateResult === 'ok' && validateDetails && !validateDone && (
                <div className="bg-brand-light rounded-xl p-4">
                  <p className="text-brand-darker font-bold text-lg mb-1">✓ {t('dash.validateOk')}</p>
                  <p className="text-sm text-brand-darker mb-1">Code: <strong>{validateDetails.code}</strong></p>
                  <p className="text-sm text-brand-darker mb-4">{t('dash.validateDiscount')}: <strong>{validateDetails.discount}</strong></p>
                  <button
                    onClick={async () => {
                      setConfirming(true)
                      // Server-side consume wraps the cv.used_at +
                      // vouchers.uses_count writes that used to fire
                      // directly from the browser. Required after the
                      // RLS lockdown of both tables.
                      await fetch('/api/vendor/vouchers/consume', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ customer_voucher_id: validateDetails.cvId }),
                      }).catch(() => null)
                      setConfirming(false)
                      setValidateDone(true)
                      setValidateResult(null)
                    }}
                    disabled={confirming}
                    className="w-full bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
                  >
                    {confirming ? t('dash.validateConfirming') : t('dash.validateConfirm')}
                  </button>
                </div>
              )}
              {validateDone && (
                <div className="bg-brand-light rounded-xl p-4 text-center">
                  <p className="text-brand-darker font-bold">✅ {t('dash.validateDone')}</p>
                </div>
              )}
            </div>
          )}

          {/* Menu Tab */}
          {tab === 'menu' && (
            <div>
              <button
                onClick={() => { setEditingItem(null); setShowItemForm(true) }}
                className="w-full bg-brand text-white py-3 rounded-2xl font-semibold mb-4 hover:bg-brand-dark transition-colors"
              >
                {t('dash.addItem')}
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
                  <div className="text-center py-12 text-ink-tertiary">
                    <div className="text-4xl mb-3">🍽️</div>
                    <p>{t('dash.noItems')}</p>
                  </div>
                )}
                {menuItems.map(item => (
                  <div key={item.id} className="bg-white rounded-2xl p-3 shadow-sm flex items-center gap-3">
                    {item.photo_url ? (
                      <div className="relative w-14 h-14 rounded-xl overflow-hidden flex-shrink-0">
                        <Image src={item.photo_url} alt={item.name} fill className="object-cover" />
                      </div>
                    ) : (
                      <div className="w-14 h-14 rounded-xl bg-brand-light flex items-center justify-center text-2xl flex-shrink-0">🍽️</div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-ink-primary text-sm truncate">{item.name}</p>
                        {item.is_daily_special && (
                          <span className="text-xs bg-brand-light text-brand-dark px-1.5 py-0.5 rounded-full">
                            {t('dash.itemSpecial')}
                          </span>
                        )}
                      </div>
                      <p className="text-brand text-sm font-semibold">CHF {item.price.toFixed(2)}</p>
                      <p className="text-xs text-ink-tertiary">{item.category}</p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <button
                        onClick={() => toggleItemAvailability(item)}
                        className={`text-xs px-2 py-1 rounded-full font-medium ${
                          item.is_available ? 'bg-brand-light text-brand-darker' : 'bg-surface-muted text-ink-secondary'
                        }`}
                      >
                        {item.is_available ? t('dash.available') : t('dash.hidden')}
                      </button>
                      <div className="flex gap-1">
                        <button
                          onClick={() => { setEditingItem(item); setShowItemForm(true) }}
                          className="text-xs text-brand-darker hover:text-brand-darker"
                        >
                          {t('dash.edit')}
                        </button>
                        <span className="text-ink-tertiary">·</span>
                        <button
                          onClick={() => deleteItem(item.id)}
                          className="text-xs text-danger hover:text-danger"
                        >
                          {t('dash.delete')}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'vouchers' && selectedRestaurant && (
            <VendorVouchersPanel
              restaurant={selectedRestaurant}
              effectiveRole={effectiveRole}
              onValidate={() => setTab('validate')}
            />
          )}

          {/* Team tab — full pending-invitations + invite UI lands in the
              follow-up commit. For now the empty-state points vendors to
              /account where the existing team roster lives. */}
          {tab === 'team' && (
            <div className="bg-white rounded-2xl p-6 shadow-sm text-center">
              <div className="text-4xl mb-3">👥</div>
              <h3 className="font-bold text-ink-primary mb-1">{bi('Équipe', 'Team')}</h3>
              <p className="text-sm text-ink-secondary mb-4">
                {bi(
                  'Gérez les membres de votre équipe depuis Compte → Équipe.',
                  'Manage your team from Account → Team.',
                )}
              </p>
              <Link
                href="/account?tab=team"
                className="inline-block bg-brand hover:bg-brand-dark text-white px-5 py-2 rounded-xl font-semibold text-sm transition-colors"
              >
                {bi('Aller à Compte', 'Go to Account')}
              </Link>
            </div>
          )}

          {tab === 'settings' && effectiveRole === 'owner' && (
            <div className="space-y-3">
              <OpeningHoursPanel restaurant={selectedRestaurant} />
              <PrepTimePanel
                restaurant={selectedRestaurant}
                onChange={updated => {
                  setSelectedRestaurant(updated)
                  setRestaurants(prev => prev.map(r => r.id === updated.id ? updated : r))
                }}
              />
              <PaymentSettingsPanel
                restaurant={selectedRestaurant}
                onChange={updated => {
                  setSelectedRestaurant(updated)
                  setRestaurants(prev => prev.map(r => r.id === updated.id ? updated : r))
                }}
              />
            </div>
          )}
          {tab === 'settings' && (effectiveRole === 'manager' || effectiveRole === 'admin') && (
            <div className="space-y-3">
              <OpeningHoursPanel restaurant={selectedRestaurant} />
              <PrepTimePanel
                restaurant={selectedRestaurant}
                onChange={updated => {
                  setSelectedRestaurant(updated)
                  setRestaurants(prev => prev.map(r => r.id === updated.id ? updated : r))
                }}
              />
            </div>
          )}
          {tab === 'settings' && effectiveRole !== 'owner' && (
            <div className="bg-white rounded-2xl p-6 shadow-sm text-center">
              <div className="text-4xl mb-3">🔒</div>
              <p className="text-sm text-ink-secondary">
                {bi(
                  'Réservé au propriétaire du restaurant.',
                  'Restricted to the restaurant owner.',
                )}
              </p>
            </div>
          )}

        </div>
      )}

      {markPaidOrder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={closeMarkPaid}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-ink-primary mb-1">
              💰 {bi('Marquer payé', 'Mark as paid')}
            </h3>
            <p className="text-xs text-ink-tertiary mb-4 font-mono">
              #{orderShortId(markPaidOrder.id)} · {Number(markPaidOrder.total_price).toLocaleString()} FCFA
            </p>

            <label className="block text-xs text-ink-secondary mb-1">
              {bi('Méthode de paiement', 'Payment method')}
            </label>
            <div className="grid grid-cols-1 gap-2 mb-4">
              {([
                { value: 'cash' as const,         label: bi('💵 Espèces / Cash',        '💵 Cash / Espèces') },
                { value: 'mtn_momo' as const,     label: bi('📱 MTN MoMo',              '📱 MTN MoMo') },
                { value: 'orange_money' as const, label: bi('📱 Orange Money',          '📱 Orange Money') },
              ]).map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMarkPaidMethod(opt.value)}
                  className={`text-left px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                    markPaidMethod === opt.value
                      ? 'border-brand bg-brand-light text-brand-darker'
                      : 'border-divider bg-surface text-ink-primary hover:bg-surface-muted'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {markPaidMethod !== 'cash' && (
              <div className="mb-4">
                <label className="block text-xs text-ink-secondary mb-1">
                  {bi('Numéro utilisé pour payer', 'Phone number used to pay')}
                </label>
                <PhoneInput
                  value={markPaidPhone}
                  onChange={(full) => setMarkPaidPhone(full)}
                  defaultCountry={selectedRestaurant?.city ? getCountryFromCity(selectedRestaurant.city).iso : undefined}
                />
              </div>
            )}

            {markPaidError && (
              <p className="text-xs text-danger mb-3">{markPaidError}</p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeMarkPaid}
                disabled={markPaidSubmitting}
                className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-surface-muted text-ink-secondary hover:bg-divider transition-colors disabled:opacity-50"
              >
                {bi('Annuler', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={confirmMarkPaid}
                disabled={markPaidSubmitting}
                className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                {markPaidSubmitting
                  ? bi('Confirmation…', 'Confirming…')
                  : bi('Confirmer le paiement', 'Confirm payment')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Opening hours panel ──────────────────────────────────────────────────────
// 7-day editor + manual override controls. Renders the current computed
// status (override or schedule) at the top so the vendor can see what
// customers see before they edit anything.
interface HoursRow {
  day_of_week: number
  open_time:   string
  close_time:  string
  is_closed:   boolean
}

function OpeningHoursPanel({ restaurant }: { restaurant: Restaurant }) {
  const bi = useBi()
  const DAY_LABELS = [
    bi('Lun', 'Mon'), bi('Mar', 'Tue'), bi('Mer', 'Wed'),
    bi('Jeu', 'Thu'), bi('Ven', 'Fri'), bi('Sam', 'Sat'), bi('Dim', 'Sun'),
  ]
  const DAY_INDEX = [1, 2, 3, 4, 5, 6, 0]  // Mon-Sun, mapped to JS getDay()

  const [hours, setHours] = useState<Record<number, HoursRow>>({})
  const [status, setStatus] = useState<{ open: boolean; source: string; current_time?: string; next_kind?: string; next_at?: string } | null>(null)
  const [override, setOverride] = useState<'open' | 'closed' | null>(
    ((restaurant as Restaurant & { manual_override?: 'open' | 'closed' | null }).manual_override) ?? null
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [toggling, setToggling] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [hRes, sRes] = await Promise.all([
        fetch(`/api/restaurants/${restaurant.id}/hours`,        { cache: 'no-store' }).then(r => r.json()),
        fetch(`/api/restaurants/open-status?ids=${restaurant.id}`, { cache: 'no-store' }).then(r => r.json()),
      ])
      const byDay: Record<number, HoursRow> = {}
      // Initialise every day so the form always renders 7 rows.
      for (let d = 0; d < 7; d++) byDay[d] = { day_of_week: d, open_time: '08:00', close_time: '22:00', is_closed: d === 0 }
      for (const h of hRes?.hours ?? []) {
        byDay[h.day_of_week] = {
          day_of_week: h.day_of_week,
          open_time:   String(h.open_time).slice(0, 5),
          close_time:  String(h.close_time).slice(0, 5),
          is_closed:   !!h.is_closed,
        }
      }
      setHours(byDay)
      setStatus(sRes?.status?.[restaurant.id] ?? null)
    } finally {
      setLoading(false)
    }
  }, [restaurant.id])

  useEffect(() => { load() }, [load])

  async function save() {
    setSaving(true)
    try {
      const payload = Object.values(hours)
      const res = await fetch(`/api/restaurants/${restaurant.id}/hours`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: payload }),
      })
      if (res.ok) load()
    } finally {
      setSaving(false)
    }
  }

  async function setOverrideTo(value: 'open' | 'closed' | null) {
    setToggling(true)
    try {
      const res = await fetch(`/api/restaurants/${restaurant.id}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ override: value }),
      })
      if (res.ok) {
        setOverride(value)
        load()
      }
    } finally {
      setToggling(false)
    }
  }

  function patch(d: number, key: keyof HoursRow, value: string | boolean) {
    setHours(prev => ({ ...prev, [d]: { ...prev[d], [key]: value } }))
  }

  // Status banner copy. Manual mode wins regardless of schedule.
  const statusBanner = (() => {
    if (!status) return null
    if (status.source === 'override') {
      return status.open
        ? bi('🟢 Ouvert (manuel)', '🟢 Open (manual)')
        : bi('🔴 Fermé (manuel)', '🔴 Closed (manual)')
    }
    return status.open
      ? bi('🟢 Ouvert (horaire)', '🟢 Open (scheduled)')
      : bi('🔴 Fermé (horaire)', '🔴 Closed (scheduled)')
  })()

  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <h2 className="text-lg font-bold text-ink-primary mb-3">
        🕐 {bi('Horaires & disponibilité', 'Hours & availability')}
      </h2>

      {loading ? (
        <div className="text-center py-6 text-ink-tertiary text-sm">…</div>
      ) : (
        <>
          {statusBanner && (
            <div className="bg-surface-muted rounded-xl px-3 py-2 mb-3 text-sm font-semibold text-ink-primary">
              {statusBanner}
              {status?.next_kind && status?.next_at && (
                <span className="ml-2 text-xs font-normal text-ink-tertiary">
                  · {status.next_kind === 'opens'
                    ? bi(`ouvre à ${status.next_at}`,  `opens at ${status.next_at}`)
                    : bi(`ferme à ${status.next_at}`, `closes at ${status.next_at}`)}
                </span>
              )}
            </div>
          )}

          {/* Manual override controls. Two big buttons + a "follow schedule"
              reset when an override is active. */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <button
              onClick={() => setOverrideTo('open')}
              disabled={toggling || override === 'open'}
              className="text-xs px-3 py-1.5 rounded-full font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50"
            >
              🟢 {bi('Ouvrir maintenant', 'Open now')}
            </button>
            <button
              onClick={() => setOverrideTo('closed')}
              disabled={toggling || override === 'closed'}
              className="text-xs px-3 py-1.5 rounded-full font-semibold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-50"
            >
              🔴 {bi('Fermer maintenant', 'Close now')}
            </button>
            {override !== null && (
              <button
                onClick={() => setOverrideTo(null)}
                disabled={toggling}
                className="text-xs px-3 py-1.5 rounded-full font-semibold bg-surface-muted text-ink-secondary border border-divider hover:bg-divider disabled:opacity-50"
              >
                ↩️ {bi('Suivre l\'horaire', 'Follow schedule')}
              </button>
            )}
          </div>
          {override !== null && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-4">
              ⚠️ {bi(
                'Mode manuel actif. Retirez-le pour revenir à l\'horaire.',
                'Manual mode active. Remove it to follow the schedule.',
              )}
            </p>
          )}

          {/* Weekly schedule editor */}
          <div className="space-y-2 mb-4">
            {DAY_INDEX.map(d => {
              const row = hours[d] ?? { day_of_week: d, open_time: '08:00', close_time: '22:00', is_closed: false }
              return (
                <div key={d} className="flex items-center gap-2 flex-wrap">
                  <span className="w-10 text-sm font-semibold text-ink-primary">{DAY_LABELS[DAY_INDEX.indexOf(d)]}</span>
                  <input
                    type="time"
                    value={row.open_time}
                    onChange={e => patch(d, 'open_time', e.target.value)}
                    disabled={row.is_closed}
                    className="border border-divider rounded-xl px-2 py-1 text-sm bg-surface disabled:opacity-50"
                  />
                  <span className="text-ink-tertiary text-xs">→</span>
                  <input
                    type="time"
                    value={row.close_time}
                    onChange={e => patch(d, 'close_time', e.target.value)}
                    disabled={row.is_closed}
                    className="border border-divider rounded-xl px-2 py-1 text-sm bg-surface disabled:opacity-50"
                  />
                  <label className="flex items-center gap-1 text-xs text-ink-secondary cursor-pointer ml-auto">
                    <input
                      type="checkbox"
                      checked={row.is_closed}
                      onChange={e => patch(d, 'is_closed', e.target.checked)}
                    />
                    {bi('Fermé', 'Closed')}
                  </label>
                </div>
              )
            })}
          </div>

          <button
            onClick={save}
            disabled={saving}
            className="w-full bg-brand hover:bg-brand-dark text-white py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50"
          >
            {saving ? '…' : bi('Enregistrer l\'horaire', 'Save schedule')}
          </button>

          {/* allow_orders_when_closed — decides whether customers can place
              an order outside opening hours. Default TRUE; some vendors
              prefer to hard-block to avoid surprise orders at 02:00. */}
          <AllowOrdersToggle restaurant={restaurant} />
        </>
      )}
    </div>
  )
}

// Tiny dedicated row for the allow_orders_when_closed switch. Renders as
// part of the OpeningHoursPanel rather than its own card so the vendor
// reads it adjacent to the schedule it's coupled with.
function AllowOrdersToggle({ restaurant }: { restaurant: Restaurant }) {
  const bi = useBi()
  const initial = (restaurant as Restaurant & { allow_orders_when_closed?: boolean }).allow_orders_when_closed
  const [allow, setAllow] = useState<boolean>(initial !== false)
  const [saving, setSaving] = useState(false)

  async function toggle() {
    const next = !allow
    setAllow(next) // optimistic
    setSaving(true)
    try {
      const res = await fetch(`/api/restaurants/${restaurant.id}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_orders_when_closed: next }),
      })
      if (!res.ok) setAllow(!next) // revert on failure
    } finally {
      setSaving(false)
    }
  }

  return (
    <label className="mt-3 flex items-start gap-3 bg-surface-muted border border-divider rounded-xl px-3 py-2.5 cursor-pointer">
      <input
        type="checkbox"
        checked={allow}
        onChange={toggle}
        disabled={saving}
        className="mt-0.5"
      />
      <span className="flex-1 text-sm">
        <strong className="block text-ink-primary">
          {bi('Accepter les commandes hors horaires', 'Accept orders outside hours')}
        </strong>
        <span className="text-xs text-ink-secondary">
          {bi(
            'Si désactivé, les clients ne peuvent pas commander quand le restaurant est fermé.',
            'When off, customers can\'t order while the restaurant is closed.',
          )}
        </span>
      </span>
    </label>
  )
}

// ── Payment settings panel ───────────────────────────────────────────────────
// Owner-only view rendered under the Settings tab. Toggles
// restaurants.payment_enabled and exposes the payout phone number (defaulted
// to the restaurant's WhatsApp number, since most vendors register their
// MoMo wallet on the same line).
function PaymentSettingsPanel({
  restaurant,
  onChange,
}: {
  restaurant: Restaurant
  onChange: (next: Restaurant) => void
}) {
  const bi = useBi()
  const [mode, setMode] = useState<PaymentMode>(
    normalizeMode(restaurant.payment_mode ?? modeFromLegacy(restaurant.payment_enabled)),
  )
  const [whatsappPay, setWhatsappPay] = useState(Boolean(restaurant.whatsapp_payment_enabled))
  const [payoutPhone, setPayoutPhone] = useState(restaurant.whatsapp ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const [savedFlash, setSavedFlash] = useState(false)
  const onlineOffered = canPayOnline(mode)

  // Detect MNO from the payout phone — same lightweight heuristic the
  // checkout flow uses, kept inline so the dashboard doesn't need to
  // import the server-only PawaPay module.
  const mno = (() => {
    const digits = payoutPhone.replace(/[^\d+]/g, '')
    if (digits.startsWith('+237')) {
      const p = digits.slice(4, 6)
      if (['65', '67', '68'].includes(p)) return 'MTN MoMo'
      if (p === '69')                     return 'Orange Money'
    }
    if (digits.startsWith('+225')) {
      const p = digits.slice(4, 6)
      if (['07', '08', '09'].includes(p)) return 'MTN MoMo'
      if (['05', '06'].includes(p))       return 'Orange Money'
      if (p === '01')                     return 'Moov Money'
    }
    if (digits.startsWith('+221')) {
      const p = digits.slice(4, 6)
      if (['77', '78'].includes(p)) return 'Orange Money'
      if (p === '76')               return 'Free Money'
    }
    if (digits.startsWith('+229')) {
      const p = digits.slice(4, 6)
      if (['96', '97'].includes(p)) return 'MTN MoMo'
      if (['94', '95'].includes(p)) return 'Moov Money'
    }
    return null
  })()

  // Persist a partial change ({ payment_mode } and/or { whatsapp_payment_enabled }).
  async function persist(patch: { payment_mode?: PaymentMode; whatsapp_payment_enabled?: boolean }) {
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/restaurants/${restaurant.id}/payment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? bi('Erreur', 'Error')); return false }
      onChange({ ...restaurant, ...(data as Partial<Restaurant>) } as Restaurant)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
      return true
    } finally {
      setSaving(false)
    }
  }

  async function pickMode(next: PaymentMode) {
    const prev = mode
    setMode(next)
    // Turning online payment off clears the WhatsApp payment flag too — the
    // server does the same, we just keep the UI in lockstep.
    if (!canPayOnline(next)) setWhatsappPay(false)
    const okSave = await persist({ payment_mode: next })
    if (!okSave) setMode(prev) // roll back optimistic flip
  }

  async function toggleWhatsappPay(next: boolean) {
    setWhatsappPay(next)
    const okSave = await persist({ whatsapp_payment_enabled: next })
    if (!okSave) setWhatsappPay(!next)
  }

  async function testPayment() {
    setSaving(true)
    setError('')
    try {
      // 100 FCFA sandbox payout to the configured number.
      const res = await fetch('/api/payments/payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId: restaurant.id, amount: 100, phoneNumber: payoutPhone, description: 'Test' }),
      })
      const data = await res.json()
      if (!res.ok) setError(data.error ?? bi('Test échoué', 'Test failed'))
      else setSavedFlash(true)
    } finally {
      setSaving(false)
    }
  }

  const MODE_OPTIONS: { value: PaymentMode; title: string; sub: string }[] = [
    { value: 'reservation_only', title: bi('📋 Réservation uniquement', '📋 Reservation only'),       sub: bi('Le client réserve, paiement sur place.', 'Customer reserves, pays on-site.') },
    { value: 'payment_only',     title: bi('💰 Paiement en ligne uniquement', '💰 Online payment only'), sub: bi('Le client doit payer en ligne (Mobile Money).', 'Customer must pay online (Mobile Money).') },
    { value: 'both',             title: bi('💰📋 Les deux', '💰📋 Both'),                                sub: bi('Le client choisit: payer ou réserver.', 'Customer chooses: pay or reserve.') },
  ]

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl p-5 shadow-sm">
        <h3 className="font-bold text-ink-primary">
          💳 {bi('Mode de paiement', 'Payment mode')}
        </h3>
        <p className="text-xs text-ink-tertiary mt-1 mb-3">
          {bi(
            'Comment vos clients paient sur le site.',
            'How your customers pay on the website.',
          )}
        </p>

        <div className="space-y-2">
          {MODE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => pickMode(opt.value)}
              disabled={saving}
              className={`w-full text-left rounded-xl border-2 px-4 py-3 transition-colors disabled:opacity-60 ${
                mode === opt.value ? 'border-brand bg-brand-light' : 'border-divider bg-surface hover:border-brand-badge'
              }`}
            >
              <p className="text-sm font-bold text-ink-primary">{opt.title}</p>
              <p className="text-xs text-ink-secondary mt-0.5">{opt.sub}</p>
            </button>
          ))}
        </div>

        {savedFlash && (
          <p className="text-xs text-brand-darker mt-3">✓ {bi('Enregistré', 'Saved')}</p>
        )}
        {error && <p className="text-xs text-danger mt-3">{error}</p>}
      </div>

      {/* WhatsApp payment — separate toggle, only meaningful when online
          payment is offered on the web (payment_only or both). */}
      {onlineOffered && (
        <label className="flex items-start gap-3 bg-white rounded-2xl p-5 shadow-sm cursor-pointer">
          <button
            type="button"
            onClick={() => toggleWhatsappPay(!whatsappPay)}
            disabled={saving}
            role="switch"
            aria-checked={whatsappPay}
            className={`relative inline-flex h-7 w-12 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors mt-0.5 ${
              whatsappPay ? 'bg-brand' : 'bg-divider'
            } ${saving ? 'opacity-60' : ''}`}
          >
            <span
              className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform ${
                whatsappPay ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
          <span className="flex-1">
            <strong className="block text-sm text-ink-primary">
              💬 {bi('Paiement WhatsApp', 'WhatsApp Payment')}
            </strong>
            <span className="text-xs text-ink-secondary">
              {bi(
                'Permettre aux clients de payer par Mobile Money via WhatsApp. Désactivé: WhatsApp = réservation uniquement.',
                'Allow customers to pay via Mobile Money on WhatsApp. Off: WhatsApp = reservation only.',
              )}
            </span>
          </span>
        </label>
      )}

      {onlineOffered && (
        <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              {bi('Numéro pour recevoir les paiements', 'Phone number for payouts')}
            </label>
            <PhoneInput
              value={payoutPhone}
              onChange={(full) => setPayoutPhone(full)}
              defaultCountry={restaurant.city ? getCountryFromCity(restaurant.city).iso : undefined}
            />
            <p className="text-xs text-ink-tertiary mt-1">
              {mno
                ? `${bi('Opérateur détecté', 'Detected operator')}: ${mno}`
                : bi("Numéro non reconnu pour le paiement mobile.", 'Phone not recognised for mobile payment.')}
            </p>
          </div>

          <button
            onClick={testPayment}
            disabled={saving || !mno}
            className="w-full bg-brand-light text-brand-darker hover:bg-brand-badge disabled:opacity-50 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
          >
            🧪 {bi('Tester le paiement (100 FCFA)', 'Test payment (100 FCFA)')}
          </button>
          <p className="text-[10px] text-ink-tertiary text-center">
            {bi(
              'Sandbox uniquement. En production, contactez le support pour activer les payouts.',
              'Sandbox only. In production, contact support to enable payouts.',
            )}
          </p>
        </div>
      )}
    </div>
  )
}

// ── Prep time panel ──────────────────────────────────────────────────────────
// Owner/manager editor for the estimated preparation range surfaced on
// cards, the detail page and order confirmations. Validated client-side
// with the same shared rules the API enforces (min ≥ 5, max ≤ 120,
// min < max) so the vendor gets instant feedback before the round-trip.
function PrepTimePanel({
  restaurant,
  onChange,
}: {
  restaurant: Restaurant
  onChange: (next: Restaurant) => void
}) {
  const bi = useBi()
  const [min, setMin] = useState(
    restaurant.prep_time_min != null ? String(restaurant.prep_time_min) : '',
  )
  const [max, setMax] = useState(
    restaurant.prep_time_max != null ? String(restaurant.prep_time_max) : '',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  const currentLabel = formatPrepTime(restaurant.prep_time_min, restaurant.prep_time_max)

  async function save() {
    const v = validatePrepTime(Number(min), Number(max))
    if (!v.ok) { setError(v.error ?? bi('Valeurs invalides', 'Invalid values')); return }
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/restaurants/${restaurant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prep_time_min: v.min, prep_time_max: v.max }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? bi('Erreur', 'Error')); return }
      onChange({ ...restaurant, prep_time_min: v.min!, prep_time_max: v.max! })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
    } catch {
      setError(bi('Erreur réseau', 'Network error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <h2 className="text-lg font-bold text-ink-primary mb-1">
        🕐 {bi('Temps de préparation', 'Prep time')}
      </h2>
      <p className="text-xs text-ink-tertiary mb-4">
        {bi(
          'Affiché aux clients sur les fiches restaurant et les confirmations de commande.',
          'Shown to customers on restaurant cards and order confirmations.',
        )}
        {currentLabel && (
          <span className="block mt-1 text-ink-secondary font-semibold">
            {bi('Actuel', 'Current')}: {currentLabel}
          </span>
        )}
      </p>

      <div className="flex items-end gap-3 mb-3 flex-wrap">
        <div>
          <label className="block text-xs font-semibold text-ink-secondary mb-1">
            {bi('Min (minutes)', 'Min (minutes)')}
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={5}
            max={120}
            value={min}
            onChange={e => setMin(e.target.value)}
            placeholder={String(PREP_TIME_DEFAULT_MIN)}
            className="w-24 border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-surface"
          />
        </div>
        <span className="pb-2 text-ink-tertiary">→</span>
        <div>
          <label className="block text-xs font-semibold text-ink-secondary mb-1">
            {bi('Max (minutes)', 'Max (minutes)')}
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={5}
            max={120}
            value={max}
            onChange={e => setMax(e.target.value)}
            placeholder={String(PREP_TIME_DEFAULT_MAX)}
            className="w-24 border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-surface"
          />
        </div>
      </div>

      <p className="text-xs text-ink-tertiary mb-4">
        💡 {bi(
          `La plupart des restaurants mettent ${PREP_TIME_DEFAULT_MIN}-${PREP_TIME_DEFAULT_MAX} min`,
          `Most restaurants set ${PREP_TIME_DEFAULT_MIN}-${PREP_TIME_DEFAULT_MAX} min`,
        )}
      </p>

      {error && <p className="text-xs text-danger mb-3">{error}</p>}
      {savedFlash && (
        <p className="text-xs text-brand-darker mb-3">✓ {bi('Enregistré', 'Saved')}</p>
      )}

      <button
        onClick={save}
        disabled={saving}
        className="w-full bg-brand hover:bg-brand-dark text-white py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50"
      >
        {saving ? '…' : bi('Enregistrer', 'Save')}
      </button>
    </div>
  )
}

// ── Vendor voucher panel ─────────────────────────────────────────────────────
// Mirrors the admin voucher tab but scoped to a single restaurant:
//   - GET /api/vendor/vouchers lists every voucher across the vendor's
//     restaurants; we filter to the currently-selected one client-side.
//   - POST /api/vendor/vouchers creates (scope locked to this restaurant).
//   - PATCH /api/vendor/vouchers/[id] toggles is_active.
//   - DELETE /api/vendor/vouchers/[id] removes a voucher that has never
//     been used.
// Staff can view but not mutate (UI hides write controls).
interface VendorVoucherRow {
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
  restaurant_id: string | null
  restaurant_name: string | null
  status: 'active' | 'inactive' | 'expired' | 'exhausted'
  created_at: string
}

// Aggregate ratings card shown above the orders list. Hidden when the
// restaurant has zero ratings — keeps the vendor's first impression of an
// empty dashboard clean. No individual ratings are surfaced (anonymous
// per spec) and there's no reply or dispute affordance.
function VendorRatingsPanel({ restaurantId }: { restaurantId: string }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [data, setData] = useState<null | {
    average: number; count: number
    distribution: Record<1 | 2 | 3 | 4 | 5, number>
    top_tags: Array<{ id: string; count: number }>
    trend: 'up' | 'down' | 'flat'
    recent_count: number
  }>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/vendor/ratings/${restaurantId}`, { cache: 'no-store' })
        const d = await res.json()
        if (!cancelled) setData(d)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [restaurantId])

  if (loading || !data) return null
  if (data.count === 0) return null

  const trendBadge = data.trend === 'up'
    ? { cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200', label: '↑ ' + bi('en hausse', 'trending up') }
    : data.trend === 'down'
      ? { cls: 'bg-rose-50 text-rose-700 border border-rose-200', label: '↓ ' + bi('en baisse', 'trending down') }
      : null

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 mb-3">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-baseline gap-2">
          <p className="text-2xl font-black text-ink-primary leading-none">
            ⭐ {data.average.toFixed(1)}
          </p>
          <p className="text-xs text-ink-tertiary">
            ({data.count} {bi('avis', 'ratings')})
          </p>
        </div>
        {trendBadge && (
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${trendBadge.cls}`}>
            {trendBadge.label}
          </span>
        )}
      </div>

      <div className="space-y-1 mb-2">
        {([5, 4, 3, 2, 1] as const).map(n => {
          const c = data.distribution[n]
          const pct = data.count > 0 ? Math.round((c / data.count) * 100) : 0
          return (
            <div key={n} className="flex items-center gap-2 text-xs text-ink-secondary">
              <span className="w-3 text-right font-mono">{n}</span>
              <span>⭐</span>
              <div className="flex-1 h-2 bg-surface-muted rounded-full overflow-hidden">
                <div className="h-full bg-amber-400" style={{ width: `${pct}%` }} />
              </div>
              <span className="w-10 text-right font-mono text-ink-tertiary">{pct}%</span>
            </div>
          )
        })}
      </div>

      {data.top_tags.length > 0 && (
        <p className="text-xs text-ink-secondary leading-relaxed">
          {data.top_tags.map(({ id, count }) => {
            const t = TAG_LOOKUP[id]
            if (!t) return null
            const label = locale === 'fr' ? t.fr : t.en
            return `${t.emoji} ${label} (${count})`
          }).filter(Boolean).join(' · ')}
        </p>
      )}

      <p className="text-[10px] text-ink-tertiary mt-2 italic">
        {bi('Avis anonymes — aucun nom n\'est affiché.', 'Anonymous reviews — no names shown.')}
      </p>
    </div>
  )
}

// Inline tag lookup so the dashboard doesn't import lib/ratings (the file
// would otherwise pull POSITIVE_TAGS + NEGATIVE_TAGS into the bundle).
// Keep this in sync with lib/ratings.ts.
const TAG_LOOKUP: Record<string, { emoji: string; fr: string; en: string }> = {
  good_food:          { emoji: '🍽️', fr: 'Bonne nourriture',          en: 'Good food' },
  fast_service:       { emoji: '⚡', fr: 'Service rapide',             en: 'Fast service' },
  correct_order:      { emoji: '✅', fr: 'Commande correcte',          en: 'Correct order' },
  good_value:         { emoji: '💰', fr: 'Bon rapport qualité-prix',   en: 'Good value' },
  good_presentation:  { emoji: '📦', fr: 'Bonne présentation',         en: 'Good presentation' },
  friendly_staff:     { emoji: '😊', fr: 'Personnel aimable',          en: 'Friendly staff' },
  too_slow:           { emoji: '🐌', fr: 'Trop lent',                  en: 'Too slow' },
  wrong_order:        { emoji: '❌', fr: 'Commande incorrecte',        en: 'Wrong order' },
  too_expensive:      { emoji: '💸', fr: 'Trop cher',                  en: 'Too expensive' },
  poor_quality:       { emoji: '😞', fr: 'Mauvaise qualité',           en: 'Poor quality' },
  poor_presentation:  { emoji: '📦', fr: 'Mauvaise présentation',      en: 'Poor presentation' },
}

function VendorVouchersPanel({
  restaurant, effectiveRole, onValidate,
}: {
  onValidate: () => void
  restaurant: Restaurant
  effectiveRole: VendorRole | null
}) {
  const bi = useBi()
  const canWrite = effectiveRole === 'owner' || effectiveRole === 'manager' || effectiveRole === 'admin'

  const [vouchers, setVouchers] = useState<VendorVoucherRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  // Filters + search — same UX as the admin tab.
  type FilterStatus = 'all' | 'active' | 'expiring' | 'expired' | 'inactive'
  const [searchQuery, setSearchQuery] = useState('')
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')

  const [code, setCode] = useState('')
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent')
  const [discountValue, setDiscountValue] = useState('')
  const [minOrder, setMinOrder] = useState('0')
  const [maxUses, setMaxUses] = useState('')
  const [perCustomerMax, setPerCustomerMax] = useState('1')
  const [expiresAt, setExpiresAt] = useState('')
  const [isActive, setIsActive] = useState(true)

  const fetchVouchers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/vendor/vouchers', { cache: 'no-store' })
      const data = await res.json()
      if (res.ok && Array.isArray(data.vouchers)) {
        setVouchers((data.vouchers as VendorVoucherRow[]).filter(v => v.restaurant_id === restaurant.id))
      }
    } finally {
      setLoading(false)
    }
  }, [restaurant.id])

  useEffect(() => { fetchVouchers() }, [fetchVouchers])

  function resetForm() {
    setCode(''); setDiscountType('percent'); setDiscountValue('')
    setMinOrder('0'); setMaxUses(''); setPerCustomerMax('1')
    setExpiresAt(''); setIsActive(true); setError('')
  }

  async function createVoucher() {
    if (!discountValue) return
    setSaving(true); setError('')
    try {
      const res = await fetch('/api/vendor/vouchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim().toUpperCase() || undefined,
          discount_type: discountType,
          discount_value: parseFloat(discountValue),
          min_order: parseFloat(minOrder) || 0,
          max_uses: maxUses ? parseInt(maxUses, 10) : null,
          per_customer_max: perCustomerMax ? parseInt(perCustomerMax, 10) : 1,
          expires_at: expiresAt || null,
          restaurant_id: restaurant.id,
          is_active: isActive,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? bi('Erreur', 'Error')); return }
      setShowForm(false)
      resetForm()
      fetchVouchers()
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(v: VendorVoucherRow) {
    await fetch(`/api/vendor/vouchers/${v.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !v.is_active }),
    })
    fetchVouchers()
  }

  async function deleteVoucher(v: VendorVoucherRow) {
    if (!confirm(bi(`Supprimer ${v.code}?`, `Delete ${v.code}?`))) return
    const res = await fetch(`/api/vendor/vouchers/${v.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      alert(data.error ?? bi('Erreur', 'Error'))
      return
    }
    fetchVouchers()
  }

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
  function isExpiringSoon(v: VendorVoucherRow): boolean {
    if (v.status !== 'active' || !v.expires_at) return false
    const diff = new Date(v.expires_at).getTime() - Date.now()
    return diff > 0 && diff <= sevenDaysMs
  }

  const filtered = vouchers.filter(v => {
    if (searchQuery && !v.code.toLowerCase().includes(searchQuery.toLowerCase())) return false
    if (filterStatus === 'all')      return true
    if (filterStatus === 'expiring') return isExpiringSoon(v)
    if (filterStatus === 'active')   return v.status === 'active' && !isExpiringSoon(v)
    return v.status === filterStatus
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-lg font-bold text-ink-primary">
          🎫 {bi('Bons', 'Vouchers')} — {restaurant.name}
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Validate-by-code surface lives on the legacy 'validate' tab.
              Staff use it at the counter to scan a customer's QR / type
              their code. Kept reachable here now that the nav 🎫 icon
              points at the management view. */}
          <button
            onClick={onValidate}
            className="bg-surface-muted hover:bg-divider text-ink-primary px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
          >
            🔍 {bi('Valider un code', 'Validate a code')}
          </button>
          {canWrite && (
            <button
              onClick={() => setShowForm(s => !s)}
              className="bg-brand hover:bg-brand-dark text-white px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
            >
              {showForm ? bi('Annuler', 'Cancel') : bi('+ Créer un bon', '+ Create voucher')}
            </button>
          )}
        </div>
      </div>

      {showForm && canWrite && (
        <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs text-ink-secondary mb-1">{bi('Code', 'Code')}</label>
              <input
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
                placeholder={bi('Laisser vide pour TCHOP-XXXX', 'Leave blank for TCHOP-XXXX')}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand uppercase font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Type', 'Type')}</label>
              <select
                value={discountType}
                onChange={e => setDiscountType(e.target.value as 'percent' | 'fixed')}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              >
                <option value="percent">{bi('Pourcentage / Percentage', 'Percentage')}</option>
                <option value="fixed">{bi('Montant fixe / Fixed', 'Fixed amount')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Valeur', 'Value')}</label>
              <input
                type="number"
                value={discountValue}
                onChange={e => setDiscountValue(e.target.value)}
                placeholder={discountType === 'percent' ? '10' : '500'}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Commande min. (FCFA)', 'Min order (FCFA)')}</label>
              <input
                type="number"
                value={minOrder}
                onChange={e => setMinOrder(e.target.value)}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Usages max (0 = illimité)', 'Max uses (0 = unlimited)')}</label>
              <input
                type="number"
                value={maxUses}
                onChange={e => setMaxUses(e.target.value)}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">{bi('Par client (max)', 'Per customer (max)')}</label>
              <input
                type="number"
                value={perCustomerMax}
                onChange={e => setPerCustomerMax(e.target.value)}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-ink-secondary mb-1">{bi('Expiration', 'Expiry')}</label>
              <input
                type="date"
                value={expiresAt}
                onChange={e => setExpiresAt(e.target.value)}
                className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm text-ink-primary cursor-pointer">
              <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
              {bi('Actif à la création', 'Active on creation')}
            </label>
          </div>
          {error && <p className="text-xs text-danger mt-3">{error}</p>}
          <button
            onClick={createVoucher}
            disabled={saving || !discountValue}
            className="w-full mt-4 bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
          >
            {saving ? '…' : bi('Créer', 'Create')}
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-2xl shadow-sm p-3 mb-4 flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder={bi('Rechercher un code…', 'Search a code…')}
          className="flex-1 min-w-[160px] border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-surface"
        />
        <div className="flex items-center gap-1 flex-wrap">
          {([
            { id: 'all',      label: bi('Tous',     'All') },
            { id: 'active',   label: bi('🟢 Actifs', '🟢 Active') },
            { id: 'expiring', label: bi('🟡 Bientôt expiré', '🟡 Expiring') },
            { id: 'expired',  label: bi('🔴 Expiré',  '🔴 Expired') },
            { id: 'inactive', label: bi('⚪ Inactif', '⚪ Inactive') },
          ] as { id: FilterStatus; label: string }[]).map(opt => (
            <button
              key={opt.id}
              onClick={() => setFilterStatus(opt.id)}
              className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors ${
                filterStatus === opt.id
                  ? 'bg-brand text-white'
                  : 'bg-surface-muted text-ink-secondary hover:bg-divider'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-ink-tertiary">…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-ink-tertiary">
          <div className="text-4xl mb-3">🎫</div>
          <p>{vouchers.length === 0
            ? bi('Aucun bon. Créez-en un!', 'No vouchers yet. Create one!')
            : bi('Aucun résultat', 'No results')}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted border-b border-divider">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{bi('Code', 'Code')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{bi('Valeur', 'Value')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{bi('Utilisations', 'Uses')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{bi('Expire', 'Expiry')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">{bi('Statut', 'Status')}</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {filtered.map(v => (
                  <tr key={v.id} className="hover:bg-surface-muted transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-mono font-bold text-ink-primary">{v.code}</p>
                    </td>
                    <td className="px-4 py-3 text-brand-dark font-semibold">
                      {isPercentDiscount(v.discount_type) ? `${v.discount_value}%` : `${Number(v.discount_value).toLocaleString()} FCFA`}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {v.current_uses ?? 0}{v.max_uses ? `/${v.max_uses}` : ''}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary text-xs">
                      {v.expires_at
                        ? new Date(v.expires_at).toLocaleDateString('fr-FR')
                        : <span className="text-ink-tertiary">∞</span>}
                    </td>
                    <td className="px-4 py-3">
                      <VendorVoucherStatusBadge
                        status={isExpiringSoon(v) ? 'expiring' : v.status}
                        canToggle={canWrite}
                        onToggle={() => toggleActive(v)}
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canWrite && (v.current_uses ?? 0) === 0 && (
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

function VendorVoucherStatusBadge({
  status, canToggle, onToggle,
}: {
  status: 'active' | 'inactive' | 'expired' | 'exhausted' | 'expiring'
  canToggle: boolean
  onToggle: () => void
}) {
  const bi = useBi()
  const STYLES: Record<typeof status, { cls: string; label: string }> = {
    active:    { cls: 'bg-brand-light text-brand-darker hover:bg-brand-badge', label: '🟢 ' + bi('Active', 'Active') },
    expiring:  { cls: 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100', label: bi('🟡 Bientôt expiré', '🟡 Expiring soon') },
    inactive:  { cls: 'bg-surface-muted text-ink-secondary hover:bg-divider',    label: '⚪ ' + bi('Inactif', 'Inactive') },
    expired:   { cls: 'bg-rose-50 text-rose-700 border border-rose-200',          label: bi('🔴 Expiré', '🔴 Expired') },
    exhausted: { cls: 'bg-surface-muted text-ink-secondary',                      label: bi('⚫ Épuisé', '⚫ Exhausted') },
  }
  const s = STYLES[status]
  const clickable = canToggle && (status === 'active' || status === 'inactive' || status === 'expiring')
  return (
    <button
      onClick={clickable ? onToggle : undefined}
      disabled={!clickable}
      className={`text-xs font-semibold px-2.5 py-1 rounded-full transition-colors ${s.cls} ${clickable ? '' : 'cursor-default opacity-80'}`}
    >
      {s.label}
    </button>
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
  const { t } = useLanguage()
  const bi = useBi()
  const [name, setName] = useState(item?.name ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [price, setPrice] = useState(item?.price?.toString() ?? '')
  // Fixed category list — must stay in sync with the WhatsApp incoming route
  // (see MENU_CATEGORIES there). Default to "Plats Principaux" on new items;
  // preserve the current value when editing (even if legacy data doesn't
  // match one of the fixed options, the <select> falls back to default).
  const [category, setCategory] = useState(item?.category ?? 'Plats Principaux')
  const [photoUrl, setPhotoUrl] = useState(item?.photo_url ?? '')
  const [isAvailable, setIsAvailable] = useState(item?.is_available ?? true)
  const [isSpecial, setIsSpecial] = useState(item?.is_daily_special ?? false)
  const [saving, setSaving] = useState(false)

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', 'menu_item')
    fd.append('pathPrefix', 'menu-items')
    const r = await fetch('/api/upload/image', { method: 'POST', body: fd })
    if (r.ok) {
      const j = await r.json()
      if (typeof j?.url === 'string') setPhotoUrl(j.url)
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
        <h3 className="font-bold text-ink-primary">{item ? t('dash.editItem') : t('dash.newItem')}</h3>
        <button onClick={onClose} className="text-ink-tertiary hover:text-ink-secondary">✕</button>
      </div>

      <div className="space-y-3">
        <input
          placeholder={t('dash.itemNamePh')}
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <textarea
          placeholder={t('dash.itemDescPh')}
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={2}
          className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand resize-none"
        />
        <div className="flex gap-2">
          <input
            placeholder={t('dash.itemPricePh')}
            type="number"
            step="0.50"
            value={price}
            onChange={e => setPrice(e.target.value)}
            className="flex-1 border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="flex-1 border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white"
            aria-label={t('dash.itemCatPh')}
          >
            <option value="Entrées">{bi('Entrées', 'Starters')}</option>
            <option value="Plats Principaux">{bi('Plats Principaux', 'Main Courses')}</option>
            <option value="Grillades">{bi('Grillades', 'Grilled')}</option>
            <option value="Boissons">{bi('Boissons', 'Drinks')}</option>
            <option value="Desserts">Desserts</option>
            <option value="Accompagnements">{bi('Accompagnements', 'Sides')}</option>
            <option value="Autre">{bi('Autre', 'Other')}</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-ink-secondary mb-1">{t('dash.photoLbl')}</label>
          <input type="file" accept="image/*" onChange={handlePhotoUpload} className="text-xs text-ink-secondary" />
          {uploading && <p className="text-xs text-brand mt-1">{t('dash.uploading')}</p>}
          {photoUrl && !uploading && (
            <div className="relative w-20 h-20 rounded-xl overflow-hidden mt-2">
              <Image src={photoUrl} alt="preview" fill className="object-cover" />
            </div>
          )}
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={isAvailable} onChange={e => setIsAvailable(e.target.checked)} className="accent-brand" />
            {t('dash.itemAvail')}
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={isSpecial} onChange={e => setIsSpecial(e.target.checked)} className="accent-brand" />
            {t('dash.itemSpecial')}
          </label>
        </div>

        <button
          onClick={handleSave}
          disabled={saving || !name || !price || uploading}
          className="w-full bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
        >
          {saving ? t('dash.saving') : item ? t('dash.save') : t('dash.addItemBtn')}
        </button>
      </div>
    </div>
  )
}
