'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────
interface EnrichedCustomer {
  id: string
  name: string
  phone: string
  city: string
  status: string
  suspended_at: string | null
  suspended_by: string | null
  suspension_reason: string | null
  deleted_at: string | null
  created_at: string
  restaurant_count: number
  roles: string[]   // team roles: 'owner' | 'manager' | 'staff'; empty = customer only
}

interface RestaurantRow {
  id: string
  name: string
  city: string
  neighborhood: string | null
  status: string
  suspended_at: string | null
  suspended_by: string | null
  suspension_reason: string | null
  deleted_at: string | null
  whatsapp: string
  is_active: boolean
  cuisine_type: string | null
}

interface OrphanedRestaurant {
  id: string
  name: string
  city: string
  neighborhood: string | null
  whatsapp: string
  status: string
  created_at: string
}

interface SimpleCustomer { id: string; name: string; phone: string; city: string }

type StatusFilter = 'all' | 'active' | 'suspended' | 'deleted'
type SortBy = 'date' | 'name' | 'status'
type AccountModalType = 'suspend' | 'delete' | 'release' | 'reactivate' | null
type RestModalType = 'suspend' | 'delete' | null

function useToast() {
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const show = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }, [])
  return { toast, show }
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function AdminAccountsPage() {
  const { toast, show: showToast } = useToast()

  // Core data
  const [accounts,     setAccounts]     = useState<EnrichedCustomer[]>([])
  const [totalInDb,    setTotalInDb]    = useState<number | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [currentRole,  setCurrentRole]  = useState<string>('')

  // UI controls
  const [search,       setSearch]       = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortBy,       setSortBy]       = useState<SortBy>('date')

  // Expandable rows
  const [expandedIds,         setExpandedIds]         = useState<Set<string>>(new Set())
  const [restaurantsByAccount, setRestaurantsByAccount] = useState<Record<string, RestaurantRow[]>>({})
  const [loadingRestsFor,     setLoadingRestsFor]     = useState<Set<string>>(new Set())

  // Orphaned restaurants
  const [orphaned,        setOrphaned]        = useState<OrphanedRestaurant[]>([])
  const [orphanCustomers, setOrphanCustomers] = useState<SimpleCustomer[]>([])
  const [loadingOrphaned, setLoadingOrphaned] = useState(false)
  const [showOrphaned,    setShowOrphaned]    = useState(false)
  const [linkSelections,  setLinkSelections]  = useState<Record<string, string>>({})
  const [linkingId,       setLinkingId]       = useState<string | null>(null)
  const [autoLinking,     setAutoLinking]     = useState(false)

  // Account actions
  const [accountModal,    setAccountModal]    = useState<{ type: AccountModalType; account: EnrichedCustomer } | null>(null)
  const [accountActionLoading, setAccountActionLoading] = useState<string | null>(null)
  const [modalReason,     setModalReason]     = useState('')
  const [cleanupLoading,  setCleanupLoading]  = useState(false)

  // Restaurant actions
  const [restModal,       setRestModal]       = useState<{ type: RestModalType; rest: RestaurantRow; accountId: string } | null>(null)
  const [restModalReason, setRestModalReason] = useState('')
  const [restActionLoading, setRestActionLoading] = useState<string | null>(null)

  // ── Load on mount ──
  useEffect(() => {
    fetchAccounts()
    fetch('/api/auth/me').then(r => r.json()).then(d => { if (d.user) setCurrentRole(d.user.role) })
  }, [])

  async function fetchAccounts() {
    setLoading(true)
    const res = await fetch('/api/admin/accounts', { cache: 'no-store' })
    const data = await res.json()
    if (data.accounts) setAccounts(data.accounts)
    if (typeof data.totalInDb === 'number' || data.totalInDb === null) setTotalInDb(data.totalInDb)
    setLoading(false)
  }

  async function fetchOrphaned() {
    setLoadingOrphaned(true)
    const res = await fetch('/api/admin/orphaned-restaurants', { cache: 'no-store' })
    const data = await res.json()
    if (data.orphaned) setOrphaned(data.orphaned)
    if (data.customers) setOrphanCustomers(data.customers)
    setLoadingOrphaned(false)
  }

  async function loadRestaurantsForAccount(accountId: string) {
    setLoadingRestsFor(prev => new Set(Array.from(prev).concat(accountId)))
    const res = await fetch(`/api/admin/accounts/${accountId}/restaurants`, { cache: 'no-store' })
    const data = await res.json()
    setRestaurantsByAccount(prev => ({ ...prev, [accountId]: data.restaurants ?? [] }))
    setLoadingRestsFor(prev => { const s = new Set(prev); s.delete(accountId); return s })
  }

  function toggleExpand(accountId: string) {
    const next = new Set(expandedIds)
    if (next.has(accountId)) {
      next.delete(accountId)
    } else {
      next.add(accountId)
      if (!restaurantsByAccount[accountId]) loadRestaurantsForAccount(accountId)
    }
    setExpandedIds(next)
  }

  // ── Account actions ──
  async function doAccountAction(account: EnrichedCustomer, action: string, reason?: string) {
    setAccountModal(null)
    setAccountActionLoading(account.id + '-' + action)
    try {
      const res = await fetch(`/api/accounts/${account.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      const data = await res.json()
      if (res.ok) {
        const labels: Record<string, string> = {
          suspend:          `⏸️ ${account.name} suspendu`,
          reactivate:       `✅ ${account.name} réactivé${data.restaurantsReactivated ? ` (+${data.restaurantsReactivated} restaurant(s))` : ''}`,
          delete:           `🗑️ ${account.name} supprimé`,
          'undo-delete':    `↩️ ${account.name} restauré${data.restaurantsReactivated ? ` (+${data.restaurantsReactivated} restaurant(s))` : ''}`,
          'release-number': `🔓 Numéro libéré`,
        }
        showToast(labels[action] ?? '✅ Fait / Done')
        if (action === 'delete')        setStatusFilter('deleted')
        if (action === 'suspend')       setStatusFilter('suspended')
        if (action === 'reactivate' || action === 'undo-delete') setStatusFilter('active')
        // Refresh restaurants list if expanded
        if (expandedIds.has(account.id)) loadRestaurantsForAccount(account.id)
        await fetchAccounts()
      } else {
        showToast(data.error ?? 'Erreur / Error', false)
      }
    } finally {
      setAccountActionLoading(null)
    }
  }

  // ── Restaurant actions ──
  async function doRestaurantAction(accountId: string, restId: string, action: string, reason?: string) {
    setRestModal(null)
    setRestActionLoading(restId + '-' + action)
    try {
      const res = await fetch(`/api/restaurants/${restId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      const data = await res.json()
      if (res.ok) {
        const restName = restaurantsByAccount[accountId]?.find(r => r.id === restId)?.name ?? ''
        const labels: Record<string, string> = {
          approve:      `✅ ${restName} approuvé`,
          suspend:      `⏸️ ${restName} suspendu`,
          reactivate:   `✅ ${restName} réactivé`,
          delete:       `🗑️ ${restName} supprimé`,
          'undo-delete': `↩️ ${restName} restauré`,
        }
        showToast(labels[action] ?? '✅ Fait / Done')
        loadRestaurantsForAccount(accountId)
        await fetchAccounts()
      } else {
        showToast(data.error ?? 'Erreur / Error', false)
      }
    } finally {
      setRestActionLoading(null)
    }
  }

  // ── Cleanup ──
  async function runCleanup() {
    setCleanupLoading(true)
    try {
      const res = await fetch('/api/admin/cleanup-expired', { method: 'POST' })
      const data = await res.json()
      if (res.ok) { showToast(`🧹 ${data.message}`); await fetchAccounts() }
      else showToast(data.error ?? 'Erreur', false)
    } finally { setCleanupLoading(false) }
  }

  // ── Auto-link orphaned ──
  async function autoLinkOrphaned() {
    setAutoLinking(true)
    const res = await fetch('/api/admin/orphaned-restaurants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoLink: true }),
    })
    const data = await res.json()
    if (res.ok) {
      const suffix = data.created ? ` (+${data.created} compte(s) créé(s) / created)` : ''
      showToast(`🔗 ${data.linked} restaurant(s) liés / linked${suffix}`)
      await Promise.all([fetchOrphaned(), fetchAccounts()])
    } else {
      showToast(data.error ?? 'Erreur', false)
    }
    setAutoLinking(false)
  }

  async function manualLink(restaurantId: string, customerId: string) {
    if (!customerId) return
    setLinkingId(restaurantId)
    const res = await fetch('/api/admin/orphaned-restaurants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, customerId }),
    })
    const data = await res.json()
    if (res.ok) {
      showToast('🔗 Restaurant lié / Linked')
      setLinkSelections(prev => { const n = { ...prev }; delete n[restaurantId]; return n })
      await Promise.all([fetchOrphaned(), fetchAccounts()])
    } else {
      showToast(data.error ?? 'Erreur', false)
    }
    setLinkingId(null)
  }

  // ── Filtering & sorting ──
  const filtered = accounts
    .filter(a => {
      const matchStatus =
        statusFilter === 'all' ||
        (statusFilter === 'deleted'   && !!a.deleted_at) ||
        (statusFilter === 'suspended' && a.status === 'suspended' && !a.deleted_at) ||
        (statusFilter === 'active'    && a.status === 'active'    && !a.deleted_at)
      const term = search.toLowerCase()
      const matchSearch = !term || a.name?.toLowerCase().includes(term) || a.phone?.includes(term)
      return matchStatus && matchSearch
    })
    .sort((a, b) => {
      if (sortBy === 'name')   return (a.name ?? '').localeCompare(b.name ?? '')
      if (sortBy === 'status') return a.status.localeCompare(b.status)
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })

  const counts = {
    all:       accounts.length,
    active:    accounts.filter(a => a.status === 'active'    && !a.deleted_at).length,
    suspended: accounts.filter(a => a.status === 'suspended' && !a.deleted_at).length,
    deleted:   accounts.filter(a => !!a.deleted_at).length,
  }

  // ── Helpers ──
  function daysUntilRelease(deletedAt: string) {
    const d = new Date(deletedAt)
    const remaining = 30 - Math.floor((Date.now() - d.getTime()) / 86400000)
    return remaining
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] px-5 py-3 rounded-2xl shadow-lg text-sm font-semibold text-white max-w-sm ${toast.ok ? 'bg-green-500' : 'bg-red-500'}`}>
          {toast.msg}
        </div>
      )}

      {/* Mismatch warning — API returned fewer rows than the DB actually has.
          Usually means SUPABASE_SERVICE_ROLE_KEY is missing in prod, or a RLS
          policy is filtering the service-role session. */}
      {!loading && totalInDb !== null && totalInDb > accounts.length && (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-semibold">⚠️ Seulement {accounts.length} comptes affichés sur {totalInDb} en base.</p>
          <p className="mt-1 text-red-600">
            Only {accounts.length} of {totalInDb} accounts are visible. The API route uses the service-role
            key and should bypass RLS — check that <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> is
            set in Vercel (Production + Preview) and redeploy. If it&apos;s set, inspect the function log for the
            <code className="font-mono"> [admin/accounts]</code> error line.
          </p>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Comptes / Accounts</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {accounts.length} comptes / accounts
            {totalInDb !== null && totalInDb !== accounts.length && (
              <span className="text-red-600"> · {totalInDb} dans la DB / in DB</span>
            )}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {currentRole === 'super_admin' && (
            <button onClick={runCleanup} disabled={cleanupLoading}
              className="text-xs bg-purple-50 text-purple-700 border border-purple-200 px-3 py-2 rounded-xl font-medium hover:bg-purple-100 disabled:opacity-50 whitespace-nowrap">
              {cleanupLoading ? '…' : '🧹 Nettoyer expirés / Clean expired'}
            </button>
          )}
          <button
            onClick={() => { setShowOrphaned(v => !v); if (!orphaned.length) fetchOrphaned() }}
            className="text-xs bg-orange-50 text-orange-700 border border-orange-200 px-3 py-2 rounded-xl font-medium hover:bg-orange-100 whitespace-nowrap">
            🔗 Non liés / Unlinked ({orphaned.length || '…'})
          </button>
        </div>
      </div>

      {/* Orphaned restaurants section */}
      {showOrphaned && (
        <div className="mb-6 bg-orange-50 border border-orange-200 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-bold text-orange-800 text-sm">🔗 Restaurants non liés / Unlinked restaurants</h2>
            <button onClick={autoLinkOrphaned} disabled={autoLinking}
              className="text-xs bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 rounded-lg font-medium disabled:opacity-50">
              {autoLinking ? '…' : '⚡ Auto-lier par téléphone / Auto-link by phone'}
            </button>
          </div>
          {loadingOrphaned ? (
            <p className="text-sm text-orange-600">Chargement…</p>
          ) : orphaned.length === 0 ? (
            <p className="text-sm text-orange-600">Aucun restaurant non lié / No unlinked restaurants</p>
          ) : (
            <div className="space-y-2">
              {orphaned.map(r => (
                <div key={r.id} className="bg-white rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-gray-900">{r.name}</p>
                    <p className="text-xs text-gray-400">{r.city}{r.neighborhood ? ` · ${r.neighborhood}` : ''} · {r.whatsapp}</p>
                  </div>
                  <div className="flex gap-2 items-center flex-wrap">
                    <select
                      value={linkSelections[r.id] ?? ''}
                      onChange={e => setLinkSelections(prev => ({ ...prev, [r.id]: e.target.value }))}
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-orange-400 bg-white"
                    >
                      <option value="">Choisir un compte / Select account…</option>
                      {orphanCustomers.map(c => (
                        <option key={c.id} value={c.id}>{c.name} · {c.phone}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => manualLink(r.id, linkSelections[r.id] ?? '')}
                      disabled={!linkSelections[r.id] || linkingId === r.id}
                      className="text-xs bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white px-3 py-1.5 rounded-lg font-medium"
                    >
                      {linkingId === r.id ? '…' : '🔗 Lier / Link'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {/* Status tabs */}
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 overflow-x-auto">
          {(['all', 'active', 'suspended', 'deleted'] as StatusFilter[]).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${statusFilter === s ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              {s === 'all' ? 'Tous / All' : s === 'active' ? 'Actifs' : s === 'suspended' ? 'Suspendus' : 'Supprimés'}
              <span className={`text-xs font-bold px-1.5 rounded-full ${statusFilter === s ? 'bg-orange-500 text-white' : 'bg-gray-300 text-gray-600'}`}>{counts[s]}</span>
            </button>
          ))}
        </div>
        {/* Sort */}
        <select value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}
          className="text-xs border border-gray-200 rounded-xl px-3 py-2 outline-none focus:border-orange-400 bg-white">
          <option value="date">Trier: date / Sort: date</option>
          <option value="name">Trier: nom / Sort: name</option>
          <option value="status">Trier: statut / Sort: status</option>
        </select>
      </div>

      {/* Search */}
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Rechercher nom ou téléphone / Search name or phone…"
        className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-orange-400 mb-4"
      />

      {/* List */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3 animate-bounce">👤</div>
          <p>Chargement…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">👤</div>
          <p>Aucun compte / No accounts</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {filtered.map((a, idx) => {
            const isExpanded    = expandedIds.has(a.id)
            const loadingRests  = loadingRestsFor.has(a.id)
            const rests         = restaurantsByAccount[a.id]
            const within30      = a.deleted_at ? daysUntilRelease(a.deleted_at) > 0 : false
            const daysLeft      = a.deleted_at ? daysUntilRelease(a.deleted_at) : null
            const alreadyReleased = a.phone?.startsWith('deleted_')

            return (
              <div key={a.id} className={idx < filtered.length - 1 ? 'border-b border-gray-50' : ''}>
                {/* Main row */}
                <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-start gap-3">

                  {/* Expand toggle */}
                  <button onClick={() => toggleExpand(a.id)}
                    className="hidden sm:flex mt-1 w-5 h-5 items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 text-xs flex-shrink-0 transition-colors">
                    {isExpanded ? '▲' : '▼'}
                  </button>

                  {/* Info */}
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => toggleExpand(a.id)}>
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <p className="font-semibold text-gray-900 text-sm">{a.name || '—'}</p>
                      <AccountStatusBadge a={a} />
                      <RoleBadges roles={a.roles} />
                    </div>
                    <p className="text-xs text-gray-500 font-mono">{a.phone}</p>
                    <div className="flex flex-wrap gap-x-3 mt-0.5">
                      <p className="text-xs text-gray-400">{a.city}</p>
                      <p className="text-xs text-gray-400">
                        {a.restaurant_count} restaurant{a.restaurant_count !== 1 ? 's' : ''}
                      </p>
                      <p className="text-xs text-gray-400">Inscrit {new Date(a.created_at).toLocaleDateString('fr-FR')}</p>
                    </div>
                    {a.suspended_by && !a.deleted_at && (
                      <p className="text-xs text-amber-600 mt-0.5">
                        Suspendu par <span className="font-semibold">{a.suspended_by}</span>
                        {a.suspended_at && ` · ${new Date(a.suspended_at).toLocaleDateString('fr-FR')}`}
                        {a.suspension_reason && ` · "${a.suspension_reason}"`}
                      </p>
                    )}
                    {a.deleted_at && !alreadyReleased && (
                      <p className="text-xs mt-0.5" style={{ color: (daysLeft ?? 0) > 5 ? '#9ca3af' : '#ef4444' }}>
                        Supprimé {new Date(a.deleted_at).toLocaleDateString('fr-FR')}
                        {' · '}
                        {(daysLeft ?? 0) > 0
                          ? `${daysLeft}j avant libération / ${daysLeft}d before release`
                          : 'À libérer / Pending release'}
                      </p>
                    )}
                    {alreadyReleased && (
                      <p className="text-xs text-gray-400 mt-0.5 italic">Numéro libéré / Number released</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 flex-wrap flex-shrink-0" onClick={e => e.stopPropagation()}>
                    {a.status === 'active' && !a.deleted_at && (
                      <>
                        <ActionBtn
                          label="⏸️ Suspendre"
                          cls="amber"
                          loading={accountActionLoading === a.id + '-suspend'}
                          onClick={() => { setModalReason(''); setAccountModal({ type: 'suspend', account: a }) }}
                        />
                        <ActionBtn
                          label="🗑️ Supprimer"
                          cls="red-outline"
                          loading={accountActionLoading === a.id + '-delete'}
                          onClick={() => setAccountModal({ type: 'delete', account: a })}
                        />
                      </>
                    )}
                    {a.status === 'suspended' && !a.deleted_at && (
                      <>
                        <ActionBtn
                          label="✅ Réactiver"
                          cls="green"
                          loading={accountActionLoading === a.id + '-reactivate'}
                          onClick={() => setAccountModal({ type: 'reactivate', account: a })}
                        />
                        <ActionBtn
                          label="🗑️ Supprimer"
                          cls="red-outline"
                          loading={accountActionLoading === a.id + '-delete'}
                          onClick={() => setAccountModal({ type: 'delete', account: a })}
                        />
                      </>
                    )}
                    {a.deleted_at && (
                      <>
                        {within30 && (
                          <ActionBtn
                            label="↩️ Annuler / Undo"
                            cls="orange"
                            loading={accountActionLoading === a.id + '-undo-delete'}
                            onClick={() => doAccountAction(a, 'undo-delete')}
                          />
                        )}
                        {currentRole === 'super_admin' && !alreadyReleased && (
                          <ActionBtn
                            label="🔓 Libérer / Release"
                            cls="red"
                            loading={accountActionLoading === a.id + '-release-number'}
                            onClick={() => setAccountModal({ type: 'release', account: a })}
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Expanded: restaurant list */}
                {isExpanded && (
                  <div className="px-5 pb-4 bg-gray-50 border-t border-gray-100">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide py-3">
                      Restaurants ({rests?.length ?? '…'})
                    </p>
                    {loadingRests ? (
                      <p className="text-sm text-gray-400 pb-3">Chargement…</p>
                    ) : !rests || rests.length === 0 ? (
                      <p className="text-sm text-gray-400 pb-3">Aucun restaurant / No restaurants</p>
                    ) : (
                      <div className="space-y-2 pb-2">
                        {rests.map(r => (
                          <RestaurantSubRow
                            key={r.id}
                            r={r}
                            accountId={a.id}
                            actionLoading={restActionLoading}
                            onSuspend={() => { setRestModalReason(''); setRestModal({ type: 'suspend', rest: r, accountId: a.id }) }}
                            onReactivate={() => doRestaurantAction(a.id, r.id, 'reactivate')}
                            onApprove={() => doRestaurantAction(a.id, r.id, 'approve')}
                            onDelete={() => setRestModal({ type: 'delete', rest: r, accountId: a.id })}
                            onUndoDelete={() => doRestaurantAction(a.id, r.id, 'undo-delete')}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Account modals ── */}

      {accountModal?.type === 'suspend' && (
        <Modal onClose={() => setAccountModal(null)}>
          <h3 className="font-bold text-gray-900 mb-1">⏸️ Suspendre le compte / Suspend account</h3>
          <p className="text-sm text-gray-500 mb-3">{accountModal.account.name} · {accountModal.account.phone}</p>
          <textarea value={modalReason} onChange={e => setModalReason(e.target.value)}
            placeholder="Raison (optionnel) / Reason (optional)" rows={3}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400 mb-4" />
          <ModalButtons
            confirmLabel="⏸️ Suspendre / Suspend" confirmCls="bg-amber-500 hover:bg-amber-600"
            onConfirm={() => doAccountAction(accountModal.account, 'suspend', modalReason)}
            onCancel={() => setAccountModal(null)} />
        </Modal>
      )}

      {accountModal?.type === 'reactivate' && (
        <Modal onClose={() => setAccountModal(null)}>
          <h3 className="font-bold text-gray-900 mb-1">✅ Réactiver le compte / Reactivate account</h3>
          <p className="text-sm text-gray-500 mb-3">{accountModal.account.name} · {accountModal.account.phone}</p>
          <p className="text-sm text-gray-500 mb-4 bg-green-50 border border-green-100 rounded-xl p-3">
            Ce compte et ses restaurants suspendus automatiquement seront réactivés.<br/>
            This account and its auto-suspended restaurants will be reactivated.
          </p>
          <ModalButtons
            confirmLabel="✅ Réactiver / Reactivate" confirmCls="bg-green-500 hover:bg-green-600"
            onConfirm={() => doAccountAction(accountModal.account, 'reactivate')}
            onCancel={() => setAccountModal(null)} />
        </Modal>
      )}

      {accountModal?.type === 'delete' && (
        <Modal onClose={() => setAccountModal(null)}>
          <h3 className="font-bold text-gray-900 mb-1">🗑️ Supprimer le compte / Delete account</h3>
          <p className="text-sm text-gray-500 mb-3">{accountModal.account.name} · {accountModal.account.phone}</p>
          <p className="text-sm text-gray-500 mb-4 bg-amber-50 border border-amber-100 rounded-xl p-3">
            ⚠️ Les données seront supprimées après 30 jours. Les restaurants actifs seront suspendus automatiquement.<br/><br/>
            Data will be deleted after 30 days. Active restaurants will be auto-suspended.
          </p>
          <ModalButtons
            confirmLabel="🗑️ Supprimer / Delete" confirmCls="bg-red-500 hover:bg-red-600"
            onConfirm={() => doAccountAction(accountModal.account, 'delete')}
            onCancel={() => setAccountModal(null)} />
        </Modal>
      )}

      {accountModal?.type === 'release' && (
        <Modal onClose={() => setAccountModal(null)}>
          <h3 className="font-bold text-gray-900 mb-1">🔓 Libérer le numéro / Release number</h3>
          <p className="text-sm text-gray-500 mb-3">{accountModal.account.name} · {accountModal.account.phone}</p>
          <p className="text-sm text-red-600 mb-4 bg-red-50 border border-red-100 rounded-xl p-3">
            ⚠️ Cette action est définitive. Le numéro sera libéré et les données anonymisées. Continuer?<br/><br/>
            This is permanent. The number will be released and data anonymized. Continue?
          </p>
          <ModalButtons
            confirmLabel="🔓 Confirmer / Confirm" confirmCls="bg-red-500 hover:bg-red-600"
            onConfirm={() => doAccountAction(accountModal.account, 'release-number')}
            onCancel={() => setAccountModal(null)} />
        </Modal>
      )}

      {/* ── Restaurant modals ── */}

      {restModal?.type === 'suspend' && (
        <Modal onClose={() => setRestModal(null)}>
          <h3 className="font-bold text-gray-900 mb-1">⏸️ Suspendre le restaurant / Suspend restaurant</h3>
          <p className="text-sm text-gray-500 mb-3">{restModal.rest.name}</p>
          <textarea value={restModalReason} onChange={e => setRestModalReason(e.target.value)}
            placeholder="Raison (optionnel) / Reason (optional)" rows={3}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400 mb-4" />
          <ModalButtons
            confirmLabel="⏸️ Suspendre / Suspend" confirmCls="bg-amber-500 hover:bg-amber-600"
            onConfirm={() => doRestaurantAction(restModal.accountId, restModal.rest.id, 'suspend', restModalReason)}
            onCancel={() => setRestModal(null)} />
        </Modal>
      )}

      {restModal?.type === 'delete' && (
        <Modal onClose={() => setRestModal(null)}>
          <h3 className="font-bold text-gray-900 mb-1">🗑️ Supprimer le restaurant / Delete restaurant</h3>
          <p className="text-sm text-gray-500 mb-3">{restModal.rest.name}</p>
          <p className="text-sm text-gray-500 mb-4 bg-amber-50 border border-amber-100 rounded-xl p-3">
            ⚠️ Annulable dans 30 jours. / Reversible within 30 days.
          </p>
          <ModalButtons
            confirmLabel="🗑️ Supprimer / Delete" confirmCls="bg-red-500 hover:bg-red-600"
            onConfirm={() => doRestaurantAction(restModal.accountId, restModal.rest.id, 'delete')}
            onCancel={() => setRestModal(null)} />
        </Modal>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RestaurantSubRow({
  r, actionLoading, onSuspend, onReactivate, onApprove, onDelete, onUndoDelete,
}: {
  r: RestaurantRow
  accountId?: string
  actionLoading: string | null
  onSuspend: () => void
  onReactivate: () => void
  onApprove: () => void
  onDelete: () => void
  onUndoDelete: () => void
}) {
  const within30 = r.deleted_at
    ? new Date(r.deleted_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    : false

  return (
    <div className="bg-white rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-semibold text-sm text-gray-900">{r.name}</p>
          <RestaurantStatusBadge r={r} />
        </div>
        <p className="text-xs text-gray-400">{r.city}{r.neighborhood ? ` · ${r.neighborhood}` : ''}</p>
        {r.suspended_by && !r.deleted_at && (
          <p className="text-xs text-amber-600">
            Suspendu par <span className="font-semibold">{r.suspended_by}</span>
            {r.suspension_reason && ` · "${r.suspension_reason}"`}
          </p>
        )}
      </div>
      <div className="flex gap-1.5 flex-wrap flex-shrink-0">
        {r.status === 'pending' && !r.deleted_at && (
          <ActionBtn label="✅ Approuver" cls="green" loading={actionLoading === r.id + '-approve'} onClick={onApprove} />
        )}
        {(r.status === 'active' || r.status === 'pending') && !r.deleted_at && (
          <>
            <ActionBtn label="⏸️ Suspendre" cls="amber" loading={actionLoading === r.id + '-suspend'} onClick={onSuspend} />
            <ActionBtn label="🗑️" cls="red-outline" loading={actionLoading === r.id + '-delete'} onClick={onDelete} />
          </>
        )}
        {r.status === 'suspended' && !r.deleted_at && (
          <>
            <ActionBtn label="✅ Réactiver" cls="green" loading={actionLoading === r.id + '-reactivate'} onClick={onReactivate} />
            <ActionBtn label="🗑️" cls="red-outline" loading={actionLoading === r.id + '-delete'} onClick={onDelete} />
          </>
        )}
        {r.deleted_at && within30 && (
          <ActionBtn label="↩️ Restaurer" cls="orange" loading={actionLoading === r.id + '-undo-delete'} onClick={onUndoDelete} />
        )}
      </div>
    </div>
  )
}

function ActionBtn({ label, cls, loading, onClick }: {
  label: string; cls: string; loading: boolean; onClick: () => void
}) {
  const styles: Record<string, string> = {
    green:       'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100',
    amber:       'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100',
    orange:      'bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100',
    'red-outline': 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100',
    red:         'bg-red-500 hover:bg-red-600 text-white',
  }
  return (
    <button onClick={onClick} disabled={loading}
      className={`text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 whitespace-nowrap ${styles[cls]}`}>
      {loading ? '…' : label}
    </button>
  )
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

function ModalButtons({ confirmLabel, confirmCls, onConfirm, onCancel }: {
  confirmLabel: string; confirmCls: string; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <div className="flex gap-3">
      <button onClick={onConfirm} className={`flex-1 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors ${confirmCls}`}>
        {confirmLabel}
      </button>
      <button onClick={onCancel} className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-200 transition-colors">
        Annuler / Cancel
      </button>
    </div>
  )
}

function RoleBadges({ roles }: { roles: string[] }) {
  if (!roles.length) return <Badge label="Client / Customer" cls="bg-blue-50 text-blue-600" />
  const map: Record<string, string> = {
    owner:   'Vendeur Owner / Vendor Owner',
    manager: 'Vendeur Manager / Vendor Manager',
    staff:   'Vendeur Staff / Vendor Staff',
  }
  return (
    <>
      {roles.map(r => (
        <Badge key={r} label={map[r] ?? r} cls="bg-indigo-50 text-indigo-600" />
      ))}
    </>
  )
}

function AccountStatusBadge({ a }: { a: EnrichedCustomer }) {
  if (a.deleted_at)          return <Badge label="Supprimé / Deleted"   cls="bg-red-100 text-red-600" />
  if (a.status === 'suspended') return <Badge label="Suspendu / Suspended" cls="bg-amber-100 text-amber-700" />
  return <Badge label="Actif / Active" cls="bg-green-100 text-green-700" />
}

function RestaurantStatusBadge({ r }: { r: RestaurantRow }) {
  if (r.deleted_at)             return <Badge label="Supprimé"  cls="bg-red-100 text-red-600" />
  if (r.status === 'suspended') return <Badge label="Suspendu"  cls="bg-amber-100 text-amber-700" />
  if (r.status === 'pending')   return <Badge label="En attente" cls="bg-yellow-100 text-yellow-700" />
  return <Badge label="Actif" cls="bg-green-100 text-green-700" />
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${cls}`}>{label}</span>
}
