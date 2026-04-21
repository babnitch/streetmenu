'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Restaurant, MenuItem, Order } from '@/types'
import { useLanguage, useBi, pickBi } from '@/lib/languageContext'
import { useMode, type DashboardTab } from '@/lib/modeContext'
import TopNav from '@/components/TopNav'

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
    { label: '✅ Confirmer / Confirm',    target: 'confirmed', roles: ['owner', 'manager'] },
    { label: '❌ Annuler / Cancel',        target: 'cancelled', roles: ['owner', 'manager'], destructive: true },
  ],
  confirmed: [
    { label: '🍳 Préparer / Start prep',   target: 'preparing', roles: ['owner', 'manager'] },
    { label: '❌ Annuler / Cancel',        target: 'cancelled', roles: ['owner', 'manager'], destructive: true },
  ],
  preparing: [
    { label: '🎉 Prête / Mark ready',      target: 'ready',     roles: ['owner', 'manager', 'staff'] },
    { label: '❌ Annuler / Cancel',        target: 'cancelled', roles: ['owner', 'manager'], destructive: true },
  ],
  ready: [
    { label: '✅ Livrée / Mark delivered', target: 'delivered', roles: ['owner', 'manager', 'staff'] },
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
    const allowed: DashboardTab[] = ['orders', 'menu', 'validate', 'team']
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
          <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-end gap-2">
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
        <div className="max-w-7xl mx-auto px-4 py-4 pb-20 md:pb-4">
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
                      const actions = (STATUS_ACTIONS[order.status] ?? [])
                        .filter(a => effectiveRole === 'admin' || (effectiveRole && a.roles.includes(effectiveRole as 'owner' | 'manager' | 'staff')))
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
                            <span className={`text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0 ${STATUS_COLORS[order.status] ?? 'bg-surface-muted text-ink-secondary'}`}>
                              {pickBi(STATUS_LABEL[order.status] ?? order.status, locale)}
                            </span>
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
                              {actions.length === 0 && (
                                <span className="text-xs text-ink-tertiary">— / —</span>
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
                          discount: v?.discount_type === 'percent' ? `-${v.discount_value}%` : `-${Number(v?.discount_value).toLocaleString()} FCFA`,
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
                          discount: v?.discount_type === 'percent' ? `-${v.discount_value}%` : `-${Number(v?.discount_value).toLocaleString()} FCFA`,
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
                      await supabase.from('customer_vouchers').update({ used_at: new Date().toISOString() }).eq('id', validateDetails.cvId)
                      const { data: cv } = await supabase.from('customer_vouchers').select('voucher_id').eq('id', validateDetails.cvId).single()
                      if (cv) {
                        const { data: vData } = await supabase.from('vouchers').select('uses_count').eq('id', cv.voucher_id).single()
                        if (vData) await supabase.from('vouchers').update({ uses_count: (vData.uses_count ?? 0) + 1 }).eq('id', cv.voucher_id)
                      }
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
