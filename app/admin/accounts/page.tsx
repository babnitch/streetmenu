'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'

interface CustomerRow {
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
}

type ModalType = 'suspend' | 'delete' | 'release' | null

function useToast() {
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const show = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }, [])
  return { toast, show }
}

export default function AdminAccountsPage() {
  const { toast, show: showToast } = useToast()

  const [accounts,      setAccounts]      = useState<CustomerRow[]>([])
  const [loading,       setLoading]       = useState(true)
  const [currentRole,   setCurrentRole]   = useState<string>('')
  const [search,        setSearch]        = useState('')
  const [statusFilter,  setStatusFilter]  = useState<'all' | 'active' | 'suspended' | 'deleted'>('all')
  const [actionLoading,  setActionLoading]  = useState<string | null>(null)
  const [cleanupLoading, setCleanupLoading] = useState(false)

  // Modal
  const [modal,      setModal]      = useState<{ type: ModalType; account: CustomerRow } | null>(null)
  const [modalReason, setModalReason] = useState('')

  useEffect(() => {
    fetchAccounts()
    // Get current admin role for permission checks
    fetch('/api/auth/me').then(r => r.json()).then(d => { if (d.user) setCurrentRole(d.user.role) })
  }, [])

  async function fetchAccounts() {
    setLoading(true)
    const res = await fetch('/api/admin/accounts', { cache: 'no-store' })
    const data = await res.json()
    if (data.accounts) setAccounts(data.accounts)
    setLoading(false)
  }

  async function runCleanup() {
    setCleanupLoading(true)
    try {
      const res = await fetch('/api/admin/cleanup-expired', { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        showToast(`🧹 ${data.message}`)
        await fetchAccounts()
      } else {
        showToast(data.error ?? 'Erreur / Error', false)
      }
    } finally {
      setCleanupLoading(false)
    }
  }

  async function doAction(account: CustomerRow, action: string, reasonText?: string) {
    setModal(null)
    setActionLoading(account.id + '-' + action)
    try {
      const res = await fetch(`/api/accounts/${account.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reasonText }),
      })
      const data = await res.json()
      if (res.ok) {
        const labels: Record<string, string> = {
          suspend:       `⏸️ ${account.name} suspendu / suspended`,
          reactivate:    `✅ ${account.name} réactivé / reactivated`,
          delete:        `🗑️ ${account.name} supprimé / deleted`,
          'undo-delete': `↩️ ${account.name} restauré / restored`,
          'release-number': `🔓 Numéro libéré / Number released`,
        }
        showToast(labels[action] ?? '✅ Fait / Done')
        // Switch to the tab where the result is visible
        if (action === 'delete')        setStatusFilter('deleted')
        if (action === 'suspend')       setStatusFilter('suspended')
        if (action === 'reactivate' || action === 'undo-delete') setStatusFilter('active')
        await fetchAccounts()
      } else {
        showToast(data.error ?? 'Erreur / Error', false)
      }
    } finally {
      setActionLoading(null)
    }
  }

  const filtered = accounts.filter(a => {
    const matchStatus = statusFilter === 'all' ||
      (statusFilter === 'deleted'   && !!a.deleted_at) ||
      (statusFilter === 'suspended' && a.status === 'suspended' && !a.deleted_at) ||
      (statusFilter === 'active'    && a.status === 'active'    && !a.deleted_at)
    const matchSearch = !search ||
      a.name?.toLowerCase().includes(search.toLowerCase()) ||
      a.phone?.includes(search) ||
      a.city?.toLowerCase().includes(search.toLowerCase())
    return matchStatus && matchSearch
  })

  const counts = {
    all:       accounts.length,
    active:    accounts.filter(a => a.status === 'active' && !a.deleted_at).length,
    suspended: accounts.filter(a => a.status === 'suspended' && !a.deleted_at).length,
    deleted:   accounts.filter(a => !!a.deleted_at).length,
  }

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] px-5 py-3 rounded-2xl shadow-lg text-sm font-semibold text-white ${toast.ok ? 'bg-green-500' : 'bg-red-500'}`}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Comptes / Accounts</h1>
          <p className="text-sm text-gray-500 mt-0.5">{accounts.length} comptes / accounts</p>
        </div>
        {currentRole === 'super_admin' && (
          <button
            onClick={runCleanup}
            disabled={cleanupLoading}
            title="Anonymise all accounts deleted more than 30 days ago"
            className="text-xs bg-purple-50 text-purple-700 border border-purple-200 px-3 py-2 rounded-xl font-medium hover:bg-purple-100 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {cleanupLoading ? '…' : '🧹 Nettoyer expirés / Clean up expired'}
          </button>
        )}
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-4 bg-gray-100 rounded-xl p-1 w-fit overflow-x-auto">
        {(['all', 'active', 'suspended', 'deleted'] as const).map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              statusFilter === s ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {s === 'all' ? 'Tous / All' : s === 'active' ? 'Actifs' : s === 'suspended' ? 'Suspendus' : 'Supprimés'}
            <span className={`text-xs font-bold px-1.5 rounded-full ${statusFilter === s ? 'bg-orange-500 text-white' : 'bg-gray-300 text-gray-600'}`}>
              {counts[s]}
            </span>
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Rechercher par nom, téléphone, ville… / Search by name, phone, city…"
        className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-orange-400 mb-4"
      />

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
            const within30Days = a.deleted_at
              ? new Date(a.deleted_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
              : false

            return (
              <div key={a.id}
                className={`flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-4 ${idx < filtered.length - 1 ? 'border-b border-gray-50' : ''}`}>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-gray-900 text-sm">{a.name || '—'}</p>
                    <AccountStatusBadge a={a} />
                  </div>
                  <p className="text-xs text-gray-400 font-mono mt-0.5">{a.phone}</p>
                  <p className="text-xs text-gray-400">{a.city} · Inscrit le {new Date(a.created_at).toLocaleDateString('fr-FR')}</p>
                  {a.suspended_by && (
                    <p className="text-xs text-amber-600 mt-0.5">
                      Suspendu par / Suspended by: <span className="font-semibold">{a.suspended_by}</span>
                      {a.suspended_at && ` · ${new Date(a.suspended_at).toLocaleDateString('fr-FR')}`}
                    </p>
                  )}
                  {a.suspension_reason && <p className="text-xs text-gray-400 mt-0.5">Raison: {a.suspension_reason}</p>}
                  {a.deleted_at && (
                    <p className="text-xs text-red-400 mt-0.5">
                      Supprimé le {new Date(a.deleted_at).toLocaleDateString('fr-FR')}
                      {within30Days ? ' · annulable / reversible' : ' · définitif / permanent'}
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-2 flex-wrap">
                  {/* Active account */}
                  {a.status === 'active' && !a.deleted_at && (
                    <>
                      <button
                        onClick={() => { setModalReason(''); setModal({ type: 'suspend', account: a }) }}
                        className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-3 py-1.5 rounded-lg font-medium hover:bg-amber-100 transition-colors"
                      >
                        ⏸️ Suspendre
                      </button>
                      <button
                        onClick={() => { setModalReason(''); setModal({ type: 'delete', account: a }) }}
                        className="text-xs bg-red-50 text-red-600 border border-red-200 px-3 py-1.5 rounded-lg font-medium hover:bg-red-100 transition-colors"
                      >
                        🗑️ Supprimer
                      </button>
                    </>
                  )}

                  {/* Suspended account */}
                  {a.status === 'suspended' && !a.deleted_at && (
                    <>
                      <button
                        onClick={() => doAction(a, 'reactivate')}
                        disabled={actionLoading === a.id + '-reactivate'}
                        className="text-xs bg-green-50 text-green-700 border border-green-200 px-3 py-1.5 rounded-lg font-medium hover:bg-green-100 transition-colors disabled:opacity-50"
                      >
                        {actionLoading === a.id + '-reactivate' ? '…' : '✅ Réactiver / Reactivate'}
                      </button>
                      <button
                        onClick={() => { setModalReason(''); setModal({ type: 'delete', account: a }) }}
                        className="text-xs bg-red-50 text-red-600 border border-red-200 px-3 py-1.5 rounded-lg font-medium hover:bg-red-100 transition-colors"
                      >
                        🗑️ Supprimer
                      </button>
                    </>
                  )}

                  {/* Deleted account */}
                  {a.deleted_at && (
                    <>
                      {within30Days && (
                        <button
                          onClick={() => doAction(a, 'undo-delete')}
                          disabled={actionLoading === a.id + '-undo-delete'}
                          className="text-xs bg-orange-50 text-orange-700 border border-orange-200 px-3 py-1.5 rounded-lg font-medium hover:bg-orange-100 transition-colors disabled:opacity-50"
                        >
                          {actionLoading === a.id + '-undo-delete' ? '…' : '↩️ Annuler suppression / Undo delete'}
                        </button>
                      )}
                      {currentRole === 'super_admin' && !a.phone?.startsWith('deleted_') && (
                        <button
                          onClick={() => setModal({ type: 'release', account: a })}
                          className="text-xs bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 rounded-lg font-medium transition-colors"
                        >
                          🔓 Libérer numéro / Release number
                        </button>
                      )}
                      {a.phone?.startsWith('deleted_') && (
                        <span className="text-xs text-gray-400 italic px-1">Numéro libéré / Released</span>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Suspend modal */}
      {modal?.type === 'suspend' && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
            <h3 className="font-bold text-gray-900 mb-1">Suspendre le compte / Suspend account</h3>
            <p className="text-sm text-gray-500 mb-3">{modal.account.name} · {modal.account.phone}</p>
            <textarea
              value={modalReason}
              onChange={e => setModalReason(e.target.value)}
              placeholder="Raison (optionnel) / Reason (optional)"
              rows={3}
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400 mb-4"
            />
            <div className="flex gap-3">
              <button onClick={() => doAction(modal.account, 'suspend', modalReason)}
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors">
                Suspendre / Suspend
              </button>
              <button onClick={() => setModal(null)}
                className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-200 transition-colors">
                Annuler / Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete modal */}
      {modal?.type === 'delete' && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
            <h3 className="font-bold text-gray-900 mb-1">Supprimer le compte / Delete account</h3>
            <p className="text-sm text-gray-500 mb-3">{modal.account.name} · {modal.account.phone}</p>
            <p className="text-sm text-gray-500 mb-4 bg-amber-50 border border-amber-100 rounded-xl p-3">
              ⚠️ Les données seront supprimées après 30 jours. Tous les restaurants de ce compte seront aussi supprimés.<br/><br/>
              Data will be deleted after 30 days. All restaurants of this account will also be deleted.
            </p>
            <div className="flex gap-3">
              <button onClick={() => doAction(modal.account, 'delete')}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors">
                Supprimer / Delete
              </button>
              <button onClick={() => setModal(null)}
                className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-200 transition-colors">
                Annuler / Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Release number modal */}
      {modal?.type === 'release' && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
            <h3 className="font-bold text-gray-900 mb-1">🔓 Libérer le numéro / Release number</h3>
            <p className="text-sm text-gray-500 mb-3">{modal.account.name} · {modal.account.phone}</p>
            <p className="text-sm text-red-600 mb-4 bg-red-50 border border-red-100 rounded-xl p-3">
              ⚠️ Cette action est définitive. Le numéro sera libéré et les données anonymisées. Continuer?<br/><br/>
              This is permanent. The number will be released and data anonymized. Continue?
            </p>
            <div className="flex gap-3">
              <button onClick={() => doAction(modal.account, 'release-number')}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors">
                Confirmer / Confirm
              </button>
              <button onClick={() => setModal(null)}
                className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-200 transition-colors">
                Annuler / Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AccountStatusBadge({ a }: { a: CustomerRow }) {
  if (a.deleted_at) return <Badge label="Supprimé / Deleted" cls="bg-red-100 text-red-600" />
  if (a.status === 'suspended') return <Badge label="Suspendu / Suspended" cls="bg-amber-100 text-amber-700" />
  return <Badge label="Actif / Active" cls="bg-green-100 text-green-700" />
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cls}`}>{label}</span>
}
