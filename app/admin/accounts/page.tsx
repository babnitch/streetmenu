'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'

interface CustomerRow {
  id: string
  name: string
  phone: string
  city: string
  status: string
  suspended_at: string | null
  suspension_reason: string | null
  deleted_at: string | null
  created_at: string
}

export default function AdminAccountsPage() {
  const [accounts, setAccounts] = useState<CustomerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [reasonModal, setReasonModal] = useState<{ id: string; action: 'suspend' | 'delete' | 'release' } | null>(null)
  const [reason, setReason] = useState('')

  useEffect(() => { fetchAccounts() }, [])

  async function fetchAccounts() {
    setLoading(true)
    const res = await fetch('/api/admin/accounts')
    const data = await res.json()
    if (data.accounts) setAccounts(data.accounts)
    setLoading(false)
  }

  async function doAction(id: string, action: string, reasonText?: string) {
    setActionLoading(id + '-' + action)
    try {
      const url = `/api/accounts/${id}/${action}`
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reasonText }),
      })
      await fetchAccounts()
    } finally {
      setActionLoading(null)
    }
  }

  const filtered = accounts.filter(a =>
    !search ||
    a.name?.toLowerCase().includes(search.toLowerCase()) ||
    a.phone?.includes(search) ||
    a.city?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Comptes / Accounts</h1>
          <p className="text-sm text-gray-500 mt-0.5">{accounts.length} comptes enregistrés / registered accounts</p>
        </div>
      </div>

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Rechercher par nom, téléphone… / Search by name, phone…"
        className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-orange-400 mb-4"
      />

      {loading ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3 animate-bounce">👤</div>
          <p>Chargement…</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {filtered.map((a, idx) => (
            <div
              key={a.id}
              className={`flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-4 ${idx < filtered.length - 1 ? 'border-b border-gray-50' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-gray-900 text-sm">{a.name || '—'}</p>
                  <StatusBadge status={a.status} />
                </div>
                <p className="text-xs text-gray-400 font-mono">{a.phone}</p>
                <p className="text-xs text-gray-400">{a.city} · {new Date(a.created_at).toLocaleDateString('fr-FR')}</p>
                {a.suspension_reason && <p className="text-xs text-orange-500 mt-0.5">Raison: {a.suspension_reason}</p>}
              </div>

              <div className="flex gap-2 flex-wrap">
                {a.status === 'active' && !a.deleted_at && (
                  <>
                    <button
                      onClick={() => { setReasonModal({ id: a.id, action: 'suspend' }); setReason('') }}
                      className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-3 py-1.5 rounded-lg font-medium hover:bg-amber-100 transition-colors"
                    >
                      Suspendre
                    </button>
                    <button
                      onClick={() => { setReasonModal({ id: a.id, action: 'delete' }); setReason('') }}
                      className="text-xs bg-red-50 text-red-600 border border-red-200 px-3 py-1.5 rounded-lg font-medium hover:bg-red-100 transition-colors"
                    >
                      Supprimer
                    </button>
                  </>
                )}
                {a.status === 'suspended' && (
                  <button
                    onClick={() => doAction(a.id, 'reactivate')}
                    disabled={actionLoading === a.id + '-reactivate'}
                    className="text-xs bg-green-50 text-green-700 border border-green-200 px-3 py-1.5 rounded-lg font-medium hover:bg-green-100 transition-colors"
                  >
                    {actionLoading === a.id + '-reactivate' ? '…' : 'Réactiver'}
                  </button>
                )}
                {a.deleted_at && (
                  <button
                    onClick={() => { setReasonModal({ id: a.id, action: 'release' }); setReason('') }}
                    className="text-xs bg-purple-50 text-purple-700 border border-purple-200 px-3 py-1.5 rounded-lg font-medium hover:bg-purple-100 transition-colors"
                  >
                    Libérer le numéro
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reason modal */}
      {reasonModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
            <h3 className="font-bold text-gray-900 mb-3">
              {reasonModal.action === 'suspend' ? 'Suspendre le compte' :
               reasonModal.action === 'delete' ? 'Supprimer le compte' : 'Libérer le numéro'}
            </h3>
            {reasonModal.action !== 'release' && (
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Raison (optionnel) / Reason (optional)"
                rows={3}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400 mb-3"
              />
            )}
            {reasonModal.action === 'release' && (
              <p className="text-sm text-gray-500 mb-3">
                Cela anonymisera les données du compte (nom et numéro). Action irréversible.<br/>
                This will anonymize account data. Irreversible.
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={async () => {
                  const { id, action } = reasonModal
                  setReasonModal(null)
                  if (action === 'release') {
                    await doAction(id, 'release-number')
                  } else {
                    await doAction(id, action, reason)
                  }
                }}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
              >
                Confirmer
              </button>
              <button
                onClick={() => setReasonModal(null)}
                className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-200 transition-colors"
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    suspended: 'bg-amber-100 text-amber-700',
    deleted: 'bg-red-100 text-red-600',
  }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${map[status] ?? 'bg-gray-100 text-gray-500'}`}>
      {status}
    </span>
  )
}
