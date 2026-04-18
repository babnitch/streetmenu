'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { useLanguage } from '@/lib/languageContext'

// ── Extended restaurant type (includes new moderation columns) ────────────────
interface RestaurantRow {
  id: string
  name: string
  description: string
  address: string
  city: string
  neighborhood: string
  lat: number
  lng: number
  phone: string
  whatsapp: string
  logo_url: string
  image_url: string | null
  is_open: boolean
  is_active: boolean
  owner_name: string
  cuisine_type: string
  status: string | null
  suspended_at: string | null
  suspended_by: string | null
  suspension_reason: string | null
  deleted_at: string | null
  created_at: string
}

// ── Form for adding a new restaurant ─────────────────────────────────────────
interface RestaurantForm {
  name: string; description: string; address: string; city: string
  lat: string; lng: string; phone: string; whatsapp: string; logo_url: string
}
const EMPTY_FORM: RestaurantForm = {
  name: '', description: '', address: '', city: '',
  lat: '', lng: '', phone: '', whatsapp: '', logo_url: '',
}

type Tab = 'all' | 'pending' | 'suspended' | 'deleted'
type ModalType = 'suspend' | 'delete' | 'reject' | null

const INPUT = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-400'

// ── Toast ─────────────────────────────────────────────────────────────────────
function useToast() {
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const show = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }, [])
  return { toast, show }
}

export default function AdminRestaurantsPage() {
  const { t } = useLanguage()
  const { toast, show: showToast } = useToast()

  const [restaurants, setRestaurants]   = useState<RestaurantRow[]>([])
  const [loading, setLoading]           = useState(true)
  const [showForm, setShowForm]         = useState(false)
  const [form, setForm]                 = useState<RestaurantForm>(EMPTY_FORM)
  const [uploading, setUploading]       = useState(false)
  const [saving, setSaving]             = useState(false)
  const [search, setSearch]             = useState('')
  const [cityFilter, setCityFilter]     = useState('all')
  const [tab, setTab]                   = useState<Tab>('all')
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // ── Modal state ──
  const [modal, setModal] = useState<{
    type:       ModalType
    restaurant: RestaurantRow
  } | null>(null)
  const [modalReason, setModalReason] = useState('')

  useEffect(() => { fetchRestaurants() }, [])

  async function fetchRestaurants() {
    setLoading(true)
    const { data } = await supabase
      .from('restaurants')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setRestaurants(data as RestaurantRow[])
    setLoading(false)
  }

  // ── Pending: approve ──
  async function approveRestaurant(r: RestaurantRow) {
    setActionLoading(r.id + '-approve')
    const { data, error } = await supabase
      .from('restaurants')
      .update({ is_active: true, status: 'active' })
      .eq('id', r.id).select().single()
    if (!error && data) {
      setRestaurants(prev => prev.map(x => x.id === r.id ? data as RestaurantRow : x))
      showToast(`✅ ${r.name} approuvé / approved`)
    } else {
      showToast('Erreur / Error', false)
    }
    setActionLoading(null)
  }

  // ── Pending: reject (hard delete) ──
  async function rejectRestaurant(r: RestaurantRow) {
    setModal({ type: 'reject', restaurant: r })
  }
  async function confirmReject(r: RestaurantRow) {
    setModal(null)
    setActionLoading(r.id + '-reject')
    const { error } = await supabase.from('restaurants').delete().eq('id', r.id)
    if (!error) {
      setRestaurants(prev => prev.filter(x => x.id !== r.id))
      showToast(`🗑️ ${r.name} rejeté / rejected`)
    } else {
      showToast('Erreur / Error', false)
    }
    setActionLoading(null)
  }

  // ── Active: suspend (via API) ──
  async function openSuspendModal(r: RestaurantRow) {
    setModalReason('')
    setModal({ type: 'suspend', restaurant: r })
  }
  async function confirmSuspend(r: RestaurantRow) {
    setModal(null)
    setActionLoading(r.id + '-suspend')
    const res = await fetch(`/api/restaurants/${r.id}/suspend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: modalReason }),
    })
    if (res.ok) {
      showToast(`⏸️ ${r.name} suspendu / suspended`)
      await fetchRestaurants()
    } else {
      const d = await res.json()
      showToast(d.error ?? 'Erreur / Error', false)
    }
    setActionLoading(null)
  }

  // ── Suspended: reactivate ──
  async function reactivateRestaurant(r: RestaurantRow) {
    setActionLoading(r.id + '-reactivate')
    const res = await fetch(`/api/restaurants/${r.id}/reactivate`, { method: 'POST' })
    if (res.ok) {
      showToast(`✅ ${r.name} réactivé / reactivated`)
      await fetchRestaurants()
    } else {
      const d = await res.json()
      showToast(d.error ?? 'Erreur / Error', false)
    }
    setActionLoading(null)
  }

  // ── Soft delete ──
  async function openDeleteModal(r: RestaurantRow) {
    setModal({ type: 'delete', restaurant: r })
  }
  async function confirmDelete(r: RestaurantRow) {
    setModal(null)
    setActionLoading(r.id + '-delete')
    const res = await fetch(`/api/restaurants/${r.id}/delete`, { method: 'POST' })
    if (res.ok) {
      showToast(`🗑️ ${r.name} supprimé / deleted`)
      await fetchRestaurants()
    } else {
      const d = await res.json()
      showToast(d.error ?? 'Erreur / Error', false)
    }
    setActionLoading(null)
  }

  // ── Undo delete ──
  async function undoDelete(r: RestaurantRow) {
    setActionLoading(r.id + '-undo')
    const res = await fetch(`/api/restaurants/${r.id}/undo-delete`, { method: 'POST' })
    if (res.ok) {
      showToast(`✅ ${r.name} restauré / restored`)
      await fetchRestaurants()
    } else {
      const d = await res.json()
      showToast(d.error ?? 'Erreur / Error', false)
    }
    setActionLoading(null)
  }

  // ── Logo upload ──
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
      showToast('Nom, ville, lat et lng requis / Name, city, lat and lng required', false)
      return
    }
    setSaving(true)
    const { data, error } = await supabase.from('restaurants').insert({
      name: form.name.trim(), description: form.description.trim(),
      address: form.address.trim(), city: form.city.trim(),
      lat: parseFloat(form.lat), lng: parseFloat(form.lng),
      phone: form.phone.trim(), whatsapp: form.whatsapp.trim(),
      logo_url: form.logo_url, is_open: false, is_active: true, status: 'active',
    }).select().single()
    setSaving(false)
    if (!error && data) {
      setRestaurants(prev => [data as RestaurantRow, ...prev])
      setForm(EMPTY_FORM)
      setShowForm(false)
      showToast('✅ Restaurant ajouté / added')
    } else {
      showToast(error?.message ?? 'Erreur / Error', false)
    }
  }

  // ── Filtered lists ──
  const pending   = restaurants.filter(r => !r.is_active && !r.deleted_at)
  const active    = restaurants.filter(r => r.is_active && !r.deleted_at && r.status !== 'suspended')
  const suspended = restaurants.filter(r => r.status === 'suspended' && !r.deleted_at)
  const deleted   = restaurants.filter(r => !!r.deleted_at)

  const tabList = tab === 'pending' ? pending : tab === 'suspended' ? suspended : tab === 'deleted' ? deleted : active
  const cities  = ['all', ...Array.from(new Set(active.map(r => r.city).filter(Boolean)))]

  const filtered = tabList.filter(r => {
    const matchCity = cityFilter === 'all' || r.city === cityFilter || tab !== 'all'
    const matchSearch = !search ||
      r.name?.toLowerCase().includes(search.toLowerCase()) ||
      r.city?.toLowerCase().includes(search.toLowerCase()) ||
      r.address?.toLowerCase().includes(search.toLowerCase())
    return matchCity && matchSearch
  })

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] px-5 py-3 rounded-2xl shadow-lg text-sm font-semibold text-white transition-all ${toast.ok ? 'bg-green-500' : 'bg-red-500'}`}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('admin.restTitle')}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {active.length} {t('admin.restActive')} · {restaurants.length} {t('admin.restTotal')}
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
      <div className="flex gap-1 mb-5 bg-gray-100 rounded-xl p-1 w-fit overflow-x-auto">
        {([ ['all', t('admin.allTab'), active.length],
            ['pending', t('admin.pendingTab'), pending.length],
            ['suspended', 'Suspendus / Suspended', suspended.length],
            ['deleted', 'Supprimés / Deleted', deleted.length],
          ] as [Tab, string, number][]).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
              tab === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
            {count > 0 && (
              <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center ${
                tab === key ? 'bg-orange-500 text-white' : 'bg-gray-300 text-gray-600'
              }`}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Add form */}
      {showForm && tab === 'all' && (
        <div className="bg-white rounded-2xl shadow-sm border border-orange-100 p-6 mb-6">
          <h2 className="font-bold text-gray-900 mb-4">{t('admin.newRest')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Nom / Name *"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Chez Mama Afrika" className={INPUT} /></Field>
            <Field label="Ville / City *"><input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder="Yaoundé" className={INPUT} /></Field>
            <Field label="Adresse / Address"><input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="Rue…" className={INPUT} /></Field>
            <Field label="Description"><input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Cuisine camerounaise…" className={INPUT} /></Field>
            <Field label="Latitude *"><input type="number" step="any" value={form.lat} onChange={e => setForm(f => ({ ...f, lat: e.target.value }))} placeholder="3.8667" className={INPUT} /></Field>
            <Field label="Longitude *"><input type="number" step="any" value={form.lng} onChange={e => setForm(f => ({ ...f, lng: e.target.value }))} placeholder="11.5167" className={INPUT} /></Field>
            <Field label="WhatsApp"><input value={form.whatsapp} onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))} placeholder="+237 6XX XXX XXX" className={INPUT} /></Field>
            <Field label="Photo" className="sm:col-span-2">
              <input type="file" accept="image/*" onChange={handleLogoUpload} className="text-sm text-gray-600" />
              {uploading && <span className="text-xs text-orange-500 ml-2">Envoi…</span>}
              {form.logo_url && !uploading && (
                <div className="relative w-24 h-16 rounded-lg overflow-hidden mt-2">
                  <Image src={form.logo_url} alt="preview" fill className="object-cover" />
                </div>
              )}
            </Field>
          </div>
          <div className="mt-4 flex gap-3">
            <button onClick={handleSave} disabled={saving || uploading || !form.name || !form.city || !form.lat || !form.lng}
              className="bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors">
              {saving ? t('admin.saving') : t('admin.addRestSaveBtn')}
            </button>
            <button onClick={() => setShowForm(false)} className="text-sm text-gray-500 hover:text-gray-700 px-4">{t('admin.cancelBtn')}</button>
          </div>
        </div>
      )}

      {/* Search + city filter (all tab only) */}
      {tab === 'all' && (
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('admin.searchPh')}
            className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-orange-400" />
          <select value={cityFilter} onChange={e => setCityFilter(e.target.value)}
            className="border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-orange-400 bg-white">
            {cities.map(c => <option key={c} value={c}>{c === 'all' ? t('admin.allCities') : c}</option>)}
          </select>
        </div>
      )}

      {/* Restaurant list */}
      {loading ? (
        <div className="text-center py-16 text-gray-400"><div className="text-4xl mb-3 animate-bounce">🍜</div><p>{t('nav.loading')}</p></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">🏪</div>
          <p>{tab === 'pending' ? t('admin.noPending') : t('admin.noResults')}</p>
          {tab === 'pending' && <p className="text-sm mt-1">{t('admin.noPendingSub')}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(r => (
            <RestaurantCard
              key={r.id}
              restaurant={r}
              tab={tab}
              actionLoading={actionLoading}
              onApprove={approveRestaurant}
              onReject={rejectRestaurant}
              onSuspend={openSuspendModal}
              onReactivate={reactivateRestaurant}
              onDelete={openDeleteModal}
              onUndoDelete={undoDelete}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {modal?.type === 'suspend' && (
        <ConfirmModal
          title={`Suspendre "${modal.restaurant.name}" / Suspend`}
          confirmLabel="Suspendre / Suspend"
          confirmClass="bg-amber-500 hover:bg-amber-600 text-white"
          onCancel={() => setModal(null)}
          onConfirm={() => confirmSuspend(modal.restaurant)}
        >
          <textarea
            value={modalReason}
            onChange={e => setModalReason(e.target.value)}
            placeholder="Raison (optionnel) / Reason (optional)"
            rows={3}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
          />
        </ConfirmModal>
      )}

      {modal?.type === 'delete' && (
        <ConfirmModal
          title={`Supprimer "${modal.restaurant.name}" / Delete`}
          confirmLabel="Supprimer / Delete"
          confirmClass="bg-red-500 hover:bg-red-600 text-white"
          onCancel={() => setModal(null)}
          onConfirm={() => confirmDelete(modal.restaurant)}
        >
          <p className="text-sm text-gray-500">
            Cette action est irréversible après 30 jours.<br/>
            This action is irreversible after 30 days.
          </p>
        </ConfirmModal>
      )}

      {modal?.type === 'reject' && (
        <ConfirmModal
          title={`Rejeter "${modal.restaurant.name}" / Reject`}
          confirmLabel="Rejeter / Reject"
          confirmClass="bg-red-500 hover:bg-red-600 text-white"
          onCancel={() => setModal(null)}
          onConfirm={() => confirmReject(modal.restaurant)}
        >
          <p className="text-sm text-gray-500">
            Le restaurant sera définitivement supprimé.<br/>
            The restaurant will be permanently deleted.
          </p>
        </ConfirmModal>
      )}
    </div>
  )
}

// ── Restaurant card ───────────────────────────────────────────────────────────
function RestaurantCard({
  restaurant: r,
  tab,
  actionLoading,
  onApprove, onReject, onSuspend, onReactivate, onDelete, onUndoDelete,
}: {
  restaurant: RestaurantRow
  tab: Tab
  actionLoading: string | null
  onApprove:    (r: RestaurantRow) => void
  onReject:     (r: RestaurantRow) => void
  onSuspend:    (r: RestaurantRow) => void
  onReactivate: (r: RestaurantRow) => void
  onDelete:     (r: RestaurantRow) => void
  onUndoDelete: (r: RestaurantRow) => void
}) {
  const within30Days = r.deleted_at
    ? new Date(r.deleted_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    : false

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-50 overflow-hidden">
      <div className="flex gap-4 p-5">
        {/* Photo */}
        <div className="relative w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 bg-orange-50">
          {(r.logo_url || r.image_url) ? (
            <Image src={(r.logo_url || r.image_url)!} alt={r.name} fill className="object-cover" />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-2xl">🏪</span>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <h3 className="font-bold text-gray-900 text-base">{r.name}</h3>
              <p className="text-sm text-gray-500">
                {r.city}{r.neighborhood ? ` · ${r.neighborhood}` : r.address ? ` · ${r.address}` : ''}
              </p>
              {r.whatsapp && (
                <a href={`https://wa.me/${r.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-green-600 font-mono hover:text-green-700">
                  {r.whatsapp}
                </a>
              )}
            </div>
            <div className="flex flex-col items-end gap-1">
              <StatusBadge r={r} />
              {r.suspended_by && <span className="text-xs text-gray-400">par / by {r.suspended_by}</span>}
            </div>
          </div>
          {r.cuisine_type && <p className="text-xs text-gray-400 mt-1">{r.cuisine_type}</p>}
          {r.suspension_reason && (
            <p className="text-xs text-amber-600 mt-1">Raison: {r.suspension_reason}</p>
          )}
          {r.deleted_at && (
            <p className="text-xs text-red-400 mt-1">
              Supprimé le {new Date(r.deleted_at).toLocaleDateString('fr-FR')}
              {within30Days && ' · annulable / reversible'}
            </p>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="border-t border-gray-50 px-5 py-3 flex gap-2 bg-gray-50/50 flex-wrap">
        {/* Pending → approve / reject */}
        {tab === 'pending' && (
          <>
            <ActionBtn
              label="✅ Approuver / Approve"
              className="bg-green-500 hover:bg-green-600 text-white"
              loading={actionLoading === r.id + '-approve'}
              onClick={() => onApprove(r)}
            />
            <ActionBtn
              label="❌ Rejeter / Reject"
              className="bg-white hover:bg-red-50 text-red-500 border border-red-200"
              loading={actionLoading === r.id + '-reject'}
              onClick={() => onReject(r)}
            />
          </>
        )}

        {/* Active → suspend / delete */}
        {tab === 'all' && !r.deleted_at && r.status !== 'suspended' && (
          <>
            <ActionBtn
              label="⏸️ Suspendre / Suspend"
              className="bg-white hover:bg-amber-50 text-amber-700 border border-amber-200"
              loading={actionLoading === r.id + '-suspend'}
              onClick={() => onSuspend(r)}
            />
            <ActionBtn
              label="🗑️ Supprimer / Delete"
              className="bg-white hover:bg-red-50 text-red-500 border border-red-200"
              loading={actionLoading === r.id + '-delete'}
              onClick={() => onDelete(r)}
            />
            <a href={`/restaurant/${r.id}`} target="_blank" rel="noopener noreferrer"
              className="text-xs text-gray-400 hover:text-orange-500 transition-colors px-2 py-1.5 ml-auto">
              ↗ Voir / View
            </a>
          </>
        )}

        {/* Suspended → reactivate / delete */}
        {tab === 'suspended' && (
          <>
            <ActionBtn
              label="✅ Réactiver / Reactivate"
              className="bg-green-500 hover:bg-green-600 text-white"
              loading={actionLoading === r.id + '-reactivate'}
              onClick={() => onReactivate(r)}
            />
            <ActionBtn
              label="🗑️ Supprimer / Delete"
              className="bg-white hover:bg-red-50 text-red-500 border border-red-200"
              loading={actionLoading === r.id + '-delete'}
              onClick={() => onDelete(r)}
            />
          </>
        )}

        {/* Deleted → undo */}
        {tab === 'deleted' && within30Days && (
          <ActionBtn
            label="↩️ Annuler suppression / Undo delete"
            className="bg-orange-500 hover:bg-orange-600 text-white"
            loading={actionLoading === r.id + '-undo'}
            onClick={() => onUndoDelete(r)}
          />
        )}
        {tab === 'deleted' && !within30Days && (
          <span className="text-xs text-gray-400 italic py-1.5">Supprimé définitivement / Permanently deleted</span>
        )}
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function ActionBtn({ label, className, loading, onClick }: {
  label: string; className: string; loading: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`text-sm font-semibold px-4 py-2 rounded-xl transition-colors disabled:opacity-50 ${className}`}
    >
      {loading ? '…' : label}
    </button>
  )
}

function StatusBadge({ r }: { r: RestaurantRow }) {
  if (r.deleted_at) return <Badge label="Supprimé / Deleted" cls="bg-red-100 text-red-600" />
  if (r.status === 'suspended') return <Badge label="Suspendu / Suspended" cls="bg-amber-100 text-amber-700" />
  if (!r.is_active) return <Badge label="En attente / Pending" cls="bg-gray-100 text-gray-600" />
  if (r.is_open) return <Badge label="Ouvert / Open" cls="bg-green-100 text-green-700" />
  return <Badge label="Actif / Active" cls="bg-blue-100 text-blue-700" />
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${cls}`}>{label}</span>
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="block text-xs text-gray-500 font-medium mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function ConfirmModal({ title, confirmLabel, confirmClass, children, onCancel, onConfirm }: {
  title: string; confirmLabel: string; confirmClass: string
  children: React.ReactNode; onCancel: () => void; onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
        <h3 className="font-bold text-gray-900 mb-4 text-base">{title}</h3>
        <div className="mb-4">{children}</div>
        <div className="flex gap-3">
          <button onClick={onConfirm} className={`flex-1 py-2.5 rounded-xl font-semibold text-sm transition-colors ${confirmClass}`}>
            {confirmLabel}
          </button>
          <button onClick={onCancel} className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-200 transition-colors">
            Annuler / Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
