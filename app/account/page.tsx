'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import dynamicLoad from 'next/dynamic'
import { supabase } from '@/lib/supabase'
import { useLanguage } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'
import VoucherCard from '@/components/VoucherCard'
import AdminProfilePanel from '@/components/AdminProfilePanel'
import { CustomerVoucher, Order } from '@/types'

// ── Lazy-loaded admin panels (no SSR) ────────────────────────────────────────
const AdminRestaurants = dynamicLoad(() => import('@/app/admin/restaurants/page'), { ssr: false })
const AdminOrders      = dynamicLoad(() => import('@/app/admin/orders/page'),      { ssr: false })
const AdminEvents      = dynamicLoad(() => import('@/app/admin/events/page'),      { ssr: false })
const AdminVouchers    = dynamicLoad(() => import('@/app/admin/vouchers/page'),    { ssr: false })
const AdminAccounts    = dynamicLoad(() => import('@/app/admin/accounts/page'),    { ssr: false })
const AdminPlatformTeam = dynamicLoad(() => import('@/app/admin/platformteam/page'), { ssr: false })

// ── Types ────────────────────────────────────────────────────────────────────
type LoginTab    = 'customer' | 'team'
type AuthStep    = 'loading' | 'login' | 'register' | 'otp' | 'dashboard'
type DashView    = 'customer' | 'vendor' | 'admin'
type CustomerTab = 'vouchers' | 'orders' | 'profile' | 'restaurant' | 'team'
type AdminSubTab = 'restaurants' | 'orders' | 'events' | 'vouchers' | 'accounts' | 'platformteam' | 'profile'

// Explicit bilingual labels — avoids the earlier bug where the label was
// built from the tab value (e.g. `account.adminNav${capitalize(sub)}`),
// which produced a non-existent key `account.adminNavPlatformteam` and
// rendered raw in the UI.
const ADMIN_TAB_LABELS: Record<AdminSubTab, string> = {
  restaurants:  'Restaurants',
  orders:       'Commandes / Orders',
  events:       'Événements / Events',
  vouchers:     'Bons / Vouchers',
  accounts:     'Comptes / Accounts',
  platformteam: 'Équipe plateforme / Platform Team',
  profile:      'Mon profil / My Profile',
}

interface SessionUser {
  id:     string
  name:   string
  role:   'customer' | 'super_admin' | 'admin' | 'moderator'
  phone?: string
  email?: string
}

interface VendorRestaurant {
  id:           string
  name:         string
  city:         string
  neighborhood: string
  cuisine_type: string
  image_url:    string | null
  is_active:    boolean
  status:       string
  deleted_at:   string | null
  suspended_at: string | null
  suspended_by: string | null
  whatsapp:     string
  teamRole:     'owner' | 'manager' | 'staff'
}

interface TeamMember {
  id:       string
  role:     string
  added_at: string
  customers: { id: string; name: string; phone: string }
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function AccountPage() {
  const { t } = useLanguage()

  // Login form state
  const [loginTab,    setLoginTab]    = useState<LoginTab>('customer')
  const [step,        setStep]        = useState<AuthStep>('loading')
  const [phone,       setPhone]       = useState('')
  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [rememberMe,  setRememberMe]  = useState(false)
  const [name,        setName]        = useState('')
  const [city,        setCity]        = useState('')
  const [otp,         setOtp]         = useState('')
  const [sending,     setSending]     = useState(false)
  const [verifying,   setVerifying]   = useState(false)
  const [loggingIn,   setLoggingIn]   = useState(false)
  const [error,       setError]       = useState('')

  // Session / dashboard
  const [user,             setUser]             = useState<SessionUser | null>(null)
  const [dashView,         setDashView]         = useState<DashView>('customer')
  const [customerTab,      setCustomerTab]      = useState<CustomerTab>('vouchers')
  const [adminSubTab,      setAdminSubTab]      = useState<AdminSubTab>('restaurants')
  const [customerVouchers, setCustomerVouchers] = useState<CustomerVoucher[]>([])
  const [orders,           setOrders]           = useState<Order[]>([])
  const [loadingData,      setLoadingData]      = useState(false)

  // Vendor state
  const [myRestaurants,    setMyRestaurants]    = useState<VendorRestaurant[]>([])
  const [activeRestId,     setActiveRestId]     = useState<string>('')
  const [teamMembers,      setTeamMembers]      = useState<TeamMember[]>([])
  const [loadingTeam,      setLoadingTeam]      = useState(false)
  const [teamPhone,        setTeamPhone]        = useState('')
  const [teamRole,         setTeamRole]         = useState('staff')
  const [addingMember,     setAddingMember]     = useState(false)
  const [teamError,        setTeamError]        = useState('')
  const [restActionLoading, setRestActionLoading] = useState('')
  const [uploadingPhoto,   setUploadingPhoto]   = useState(false)

  // Profile tab
  interface ProfileRow {
    id: string; name: string; phone: string; city: string
    status: string
    suspended_at: string | null; suspended_by: string | null; suspension_reason: string | null
    deleted_at: string | null; created_at: string
  }
  const [profile,         setProfile]         = useState<ProfileRow | null>(null)
  const [profileEditing,  setProfileEditing]  = useState(false)
  const [profileName,     setProfileName]     = useState('')
  const [profileCity,     setProfileCity]     = useState('')
  const [savingProfile,   setSavingProfile]   = useState(false)
  const PROFILE_CITIES = ['Yaoundé', 'Abidjan', 'Dakar', 'Lomé']

  // Modals
  type VendorModal = 'suspend-rest' | 'delete-rest' | 'delete-account' | null
  const [vendorModal,      setVendorModal]      = useState<VendorModal>(null)
  const [modalReason,      setModalReason]      = useState('')
  const [accountDeletedAt, setAccountDeletedAt] = useState<string | null>(null)

  // Toast
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  function showToast(msg: string, ok = true) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  // ── On mount: check JWT session ──
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(data => {
        if (data.user) {
          const u: SessionUser = data.user
          setUser(u)
          setStep('dashboard')
          if (['super_admin', 'admin', 'moderator'].includes(u.role)) {
            setDashView('admin')
          } else {
            setDashView('customer')
            loadCustomerData(u.id)
            loadMyRestaurants()
          }
        } else {
          setStep('login')
        }
      })
      .catch(() => setStep('login'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadCustomerData = useCallback(async (customerId: string) => {
    setLoadingData(true)
    const [{ data: cvData }, { data: ordersData }] = await Promise.all([
      supabase.from('customer_vouchers').select('*, vouchers(*)').eq('customer_id', customerId).order('claimed_at', { ascending: false }),
      supabase.from('orders').select('*, restaurants(name, city)').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(20),
    ])
    if (cvData) setCustomerVouchers(cvData)
    if (ordersData) setOrders(ordersData)
    setLoadingData(false)
  }, [])

  async function loadMyRestaurants() {
    const res = await fetch('/api/vendor/restaurants')
    const data = await res.json()
    if (data.restaurants?.length) {
      setMyRestaurants(data.restaurants)
      setActiveRestId(data.restaurants[0].id)
    }
  }

  async function loadTeam(restaurantId: string) {
    setLoadingTeam(true)
    const res = await fetch(`/api/restaurants/${restaurantId}/team`)
    const data = await res.json()
    setTeamMembers(data.team ?? [])
    setLoadingTeam(false)
  }

  // Load team when switching to team tab
  useEffect(() => {
    if (customerTab === 'team' && activeRestId) loadTeam(activeRestId)
    if (customerTab === 'profile' && !profile) loadProfile()
  }, [customerTab, activeRestId, profile])

  // Name of the known customer when check-phone confirms existence.
  // Lets the OTP screen greet them by name without exposing their details.
  const [knownName, setKnownName] = useState<string | null>(null)

  // ── Customer login: check phone, then send OTP ──
  // Two-phase flow so a customer who registered via WhatsApp goes straight to
  // code entry instead of being asked for name/city again.
  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const cleaned = phone.trim()
    console.log('[login-flow] submit, cleaned phone =', JSON.stringify(cleaned))
    if (!cleaned) return
    setSending(true)
    try {
      console.log('[login-flow] calling check-phone…')
      const checkRes = await fetch(
        `/api/auth/check-phone?phone=${encodeURIComponent(cleaned)}`
      )
      const check = await checkRes.json()
      console.log('[login-flow] check-phone status =', checkRes.status, 'body =', check)
      if (!checkRes.ok) { setError(check.error || 'Erreur / Error'); return }

      if (check.exists) {
        console.log('[login-flow] existing customer — skipping register form, sending code')
        setKnownName(check.name ?? null)
        const sendRes = await fetch('/api/auth/send-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: cleaned }),
        })
        const sendData = await sendRes.json()
        console.log('[login-flow] send-code status =', sendRes.status, 'body =', sendData)
        if (!sendRes.ok) { setError(sendData.error || 'Erreur / Error'); return }
        setStep('otp')
        return
      }

      console.log('[login-flow] new customer — showing register form')
      setKnownName(null)
      setStep('register')
    } finally {
      setSending(false)
    }
  }

  // ── Register (new customer) ──
  async function handleRegisterSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!name.trim() || !city) return
    setSending(true)
    try {
      const res  = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), name: name.trim(), city }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Erreur / Error'); return }
      setStep('otp')
    } finally {
      setSending(false)
    }
  }

  // ── Verify OTP ──
  async function verifyOtp() {
    setError('')
    setVerifying(true)
    try {
      const res  = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: phone.trim(),
          code:  otp.trim(),
          rememberMe,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(city        ? { city }               : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Erreur / Error'); return }
      const u: SessionUser = { id: data.customer.id, phone: data.customer.phone, name: data.customer.name, role: 'customer' }
      setUser(u)
      setStep('dashboard')
      setDashView('customer')
      loadCustomerData(u.id)
      loadMyRestaurants()
    } finally {
      setVerifying(false)
    }
  }

  // ── Admin / team login ──
  async function handleAdminLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoggingIn(true)
    try {
      const res  = await fetch('/api/auth/admin-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, rememberMe }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Erreur'); return }
      const u: SessionUser = { id: data.user.id, email: data.user.email, name: data.user.name, role: data.user.role }
      setUser(u)
      setStep('dashboard')
      setDashView('admin')
    } finally {
      setLoggingIn(false)
    }
  }

  // ── Sign out ──
  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    setUser(null)
    setPhone(''); setEmail(''); setPassword(''); setName(''); setCity(''); setOtp('')
    setMyRestaurants([]); setCustomerVouchers([]); setOrders([])
    setStep('login')
  }

  // ── Vendor: restaurant actions ──
  const activeRest = myRestaurants.find(r => r.id === activeRestId)

  async function handleRestaurantAction(action: 'suspend' | 'reactivate' | 'delete' | 'undo-delete') {
    if (!activeRestId) return
    setVendorModal(null)
    setRestActionLoading(action)
    try {
      const res = await fetch(`/api/restaurants/${activeRestId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: modalReason }),
      })
      const data = await res.json()
      if (res.ok) {
        const labels: Record<string, string> = {
          suspend: '⏸️ Restaurant suspendu / suspended',
          reactivate: '✅ Restaurant réactivé / reactivated',
          delete: '🗑️ Restaurant supprimé / deleted',
          'undo-delete': '↩️ Suppression annulée / Deletion undone',
        }
        showToast(labels[action] ?? '✅ Fait / Done')
        setModalReason('')
        await loadMyRestaurants()
      } else {
        showToast(data.error ?? 'Erreur / Error', false)
      }
    } finally {
      setRestActionLoading('')
    }
  }

  // ── Vendor: delete own account ──
  async function handleDeleteAccount() {
    if (!user) return
    setVendorModal(null)
    const res = await fetch(`/api/accounts/${user.id}/delete`, { method: 'POST' })
    const data = await res.json()
    if (res.ok) {
      showToast('🗑️ Compte supprimé / Account deleted')
      setAccountDeletedAt(new Date().toISOString())
    } else {
      showToast(data.error ?? 'Erreur / Error', false)
    }
  }

  async function handleUndoDeleteAccount() {
    if (!user) return
    const res = await fetch(`/api/accounts/${user.id}/undo-delete`, { method: 'POST' })
    const data = await res.json()
    if (res.ok) {
      showToast('↩️ Suppression annulée / Deletion undone')
      setAccountDeletedAt(null)
    } else {
      showToast(data.error ?? 'Erreur / Error', false)
    }
  }

  // ── Vendor: add team member ──
  async function handleAddTeamMember(e: React.FormEvent) {
    e.preventDefault()
    setTeamError('')
    setAddingMember(true)
    try {
      const res = await fetch(`/api/restaurants/${activeRestId}/team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: teamPhone.trim(), role: teamRole }),
      })
      const data = await res.json()
      if (!res.ok) { setTeamError(data.error ?? 'Erreur'); return }
      setTeamPhone('')
      await loadTeam(activeRestId)
    } finally {
      setAddingMember(false)
    }
  }

  async function handleRemoveTeamMember(memberId: string) {
    await fetch(`/api/restaurants/${activeRestId}/team/${memberId}`, { method: 'DELETE' })
    await loadTeam(activeRestId)
  }

  async function handleChangeRole(memberId: string, role: string) {
    const res = await fetch(`/api/restaurants/${activeRestId}/team/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    if (res.ok) {
      showToast('✅ Rôle mis à jour / Role updated')
      await loadTeam(activeRestId)
    } else {
      const d = await res.json()
      showToast(d.error ?? 'Erreur / Error', false)
    }
  }

  async function loadProfile() {
    const res = await fetch('/api/auth/profile', { cache: 'no-store' })
    if (!res.ok) return
    const data = await res.json()
    if (data.profile) {
      setProfile(data.profile)
      setProfileName(data.profile.name ?? '')
      setProfileCity(data.profile.city ?? '')
      setAccountDeletedAt(data.profile.deleted_at ?? null)
    }
  }

  async function handleSaveProfile() {
    if (!profile) return
    setSavingProfile(true)
    try {
      const res = await fetch('/api/auth/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: profileName, city: profileCity }),
      })
      const data = await res.json()
      if (res.ok) {
        setProfile(p => (p ? { ...p, name: profileName, city: profileCity } : p))
        setProfileEditing(false)
        showToast('✅ Profil mis à jour / Profile updated')
      } else {
        showToast(data.error ?? 'Erreur / Error', false)
      }
    } finally {
      setSavingProfile(false)
    }
  }

  async function handleRestaurantPhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !activeRestId) return
    setUploadingPhoto(true)
    try {
      const path = `restaurants/${Date.now()}-${file.name.replace(/\s+/g, '-')}`
      const { error: upErr } = await supabase.storage.from('photos').upload(path, file)
      if (upErr) { showToast('Erreur upload / Upload error', false); return }
      const { data: urlData } = supabase.storage.from('photos').getPublicUrl(path)
      const res = await fetch(`/api/restaurants/${activeRestId}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: urlData.publicUrl }),
      })
      if (res.ok) {
        showToast('✅ Photo mise à jour / Photo updated')
        await loadMyRestaurants()
      } else {
        const d = await res.json()
        showToast(d.error ?? 'Erreur / Error', false)
      }
    } finally {
      setUploadingPhoto(false)
      e.target.value = ''
    }
  }

  // ── Admin permission checks ──
  function adminCan(tab: AdminSubTab): boolean {
    if (!user) return false
    // Everyone in the admin dashboard can see their own profile
    if (tab === 'profile') return true
    if (user.role === 'super_admin') return true
    if (user.role === 'admin') return tab !== 'platformteam'
    if (user.role === 'moderator') return ['restaurants', 'orders', 'events'].includes(tab)
    return false
  }

  // ── Loading splash ──
  if (step === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#fffaf5' }}>
        <div className="text-4xl animate-bounce">👤</div>
      </div>
    )
  }

  const containerClass =
    step === 'dashboard' && dashView === 'admin'
      ? 'max-w-5xl mx-auto px-4 py-8'
      : 'max-w-md mx-auto px-4 py-8'

  return (
    <div className="min-h-screen" style={{ background: '#fffaf5' }}>
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] px-5 py-3 rounded-2xl shadow-lg text-sm font-semibold text-white transition-all max-w-sm ${toast.ok ? 'bg-green-500' : 'bg-red-500'}`}>
          {toast.msg}
        </div>
      )}

      <TopNav />

      <div className={containerClass}>

        {/* ── Login ── */}
        {step === 'login' && (
          <div className="max-w-md mx-auto bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-5">
              <div className="text-5xl mb-3">👤</div>
              <h1 className="text-xl font-bold text-gray-900">{t('account.title')}</h1>
            </div>

            {/* Login tabs */}
            <div className="flex bg-gray-100 rounded-2xl p-1 mb-5 gap-1">
              <button
                onClick={() => { setLoginTab('customer'); setError('') }}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${loginTab === 'customer' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {t('account.tabCustomer')}
              </button>
              <button
                onClick={() => { setLoginTab('team'); setError('') }}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${loginTab === 'team' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {t('account.tabTeam')}
              </button>
            </div>

            {loginTab === 'customer' && (
              <form onSubmit={handleSendCode} autoComplete="on" className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('account.phoneLbl')}</label>
                  <input
                    type="tel" name="phone" autoComplete="tel"
                    value={phone} onChange={e => setPhone(e.target.value)}
                    placeholder={t('account.phonePh')}
                    className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400"
                  />
                  <p className="text-xs text-gray-400 mt-1">{t('account.whatsappHint')}</p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="w-4 h-4 rounded accent-orange-500" />
                  <span className="text-sm text-gray-600">{t('account.rememberMe')}</span>
                </label>
                {error && <p className="text-xs text-red-500">{error}</p>}
                <button
                  type="submit"
                  disabled={sending || !phone.trim()}
                  className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors"
                >
                  {sending ? t('account.sending') : t('account.sendOtp')}
                </button>
              </form>
            )}

            {loginTab === 'team' && (
              <form onSubmit={handleAdminLogin} autoComplete="on" className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('account.emailLbl')}</label>
                  <input
                    type="email" name="email" autoComplete="email"
                    value={email} onChange={e => setEmail(e.target.value)}
                    placeholder={t('account.emailPh')}
                    className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('account.passwordLbl')}</label>
                  <input
                    type="password" name="password" autoComplete="current-password"
                    value={password} onChange={e => setPassword(e.target.value)}
                    placeholder={t('account.passwordPh')}
                    className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400"
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="w-4 h-4 rounded accent-orange-500" />
                  <span className="text-sm text-gray-600">{t('account.rememberMe')}</span>
                </label>
                {error && <p className="text-xs text-red-500">{error}</p>}
                <button
                  type="submit"
                  disabled={loggingIn || !email.trim() || !password.trim()}
                  className="w-full bg-gray-800 hover:bg-gray-900 disabled:bg-gray-400 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors"
                >
                  {loggingIn ? t('account.loggingIn') : t('account.loginBtn')}
                </button>
              </form>
            )}
          </div>
        )}

        {/* ── Register ── */}
        {step === 'register' && (
          <div className="max-w-md mx-auto bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">🎉</div>
              <h1 className="text-xl font-bold text-gray-900">{t('account.setupBtn')}</h1>
              <p className="text-sm text-green-600 font-medium mt-1">{t('account.setupSub')}</p>
            </div>
            <form onSubmit={handleRegisterSubmit} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('account.nameLbl')}</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder={t('account.namePh')}
                  className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Ville / City</label>
                <select value={city} onChange={e => setCity(e.target.value)}
                  className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400 bg-white">
                  <option value="">Choisir / Select…</option>
                  <option value="Yaoundé">Yaoundé</option>
                  <option value="Abidjan">Abidjan</option>
                  <option value="Dakar">Dakar</option>
                  <option value="Lomé">Lomé</option>
                </select>
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              <button type="submit" disabled={sending || !name.trim() || !city}
                className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors">
                {sending ? t('account.sending') : t('account.sendOtp')}
              </button>
              <button type="button" onClick={() => { setStep('login'); setError('') }}
                className="w-full text-gray-400 text-sm py-2 hover:text-gray-600 transition-colors">
                {t('account.changePhone')}
              </button>
            </form>
          </div>
        )}

        {/* ── OTP ── */}
        {step === 'otp' && (
          <div className="max-w-md mx-auto bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">💬</div>
              <h1 className="text-xl font-bold text-gray-900">{t('account.otpLbl')}</h1>
              {knownName && (
                <p className="text-sm text-gray-700 font-semibold mt-1">👋 {knownName}</p>
              )}
              <p className="text-sm text-gray-500 mt-1">{phone}</p>
              <p className="text-xs text-green-600 font-medium mt-1">{t('account.checkWhatsApp')}</p>
            </div>
            <input
              type="text" inputMode="numeric"
              value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="1234"
              className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400 text-center tracking-[0.5em] font-mono text-xl mb-3"
            />
            {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
            <button onClick={verifyOtp} disabled={verifying || otp.length < 4}
              className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors mb-3">
              {verifying ? t('account.verifying') : t('account.verify')}
            </button>
            <button onClick={() => { setStep('login'); setOtp(''); setError('') }}
              className="w-full text-gray-400 text-sm py-2 hover:text-gray-600 transition-colors">
              {t('account.changePhone')}
            </button>
          </div>
        )}

        {/* ── Dashboard ── */}
        {step === 'dashboard' && user && (
          <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <p className="text-xs text-gray-400">{t('account.hello')}</p>
                <p className="font-bold text-gray-900 text-lg">
                  {dashView === 'admin' ? `🔐 ${user.name}` : user.name}
                  {dashView === 'admin' && <span className="ml-2 text-xs text-gray-400 font-normal">({user.role.replace('_', ' ')})</span>}
                </p>
              </div>
              <button onClick={handleSignOut}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors px-3 py-1.5 rounded-xl hover:bg-red-50">
                {t('account.signOut')}
              </button>
            </div>

            {/* ══════════════════════════════════════════════════════════
                ADMIN DASHBOARD
               ══════════════════════════════════════════════════════════ */}
            {dashView === 'admin' && (() => {
              const allAdminTabs: AdminSubTab[] = ['restaurants', 'orders', 'events', 'vouchers', 'accounts', 'platformteam', 'profile']
              const visibleTabs = allAdminTabs.filter(adminCan)
              if (typeof window !== 'undefined') {
                console.log('[admin-tabs] user.role =', user.role, '| visible =', visibleTabs, '| profile visible?', visibleTabs.includes('profile'))
              }
              return (
              <div>
                <div className="flex flex-wrap gap-2 mb-5">
                  {visibleTabs
                    .map(sub => (
                      <button key={sub}
                        onClick={() => setAdminSubTab(sub)}
                        className={`px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap transition-colors ${
                          adminSubTab === sub ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 shadow-sm hover:text-gray-900'
                        }`}
                      >
                        {ADMIN_TAB_LABELS[sub]}
                      </button>
                    ))}
                </div>
                {adminSubTab === 'restaurants'  && <AdminRestaurants />}
                {adminSubTab === 'orders'       && <AdminOrders />}
                {adminSubTab === 'events'       && <AdminEvents />}
                {adminSubTab === 'vouchers'     && <AdminVouchers />}
                {adminSubTab === 'accounts'     && <AdminAccounts />}
                {adminSubTab === 'platformteam' && <AdminPlatformTeam />}
                {adminSubTab === 'profile'      && <AdminProfilePanel />}
              </div>
              )
            })()}

            {/* ══════════════════════════════════════════════════════════
                CUSTOMER / VENDOR DASHBOARD
               ══════════════════════════════════════════════════════════ */}
            {dashView === 'customer' && (
              <>
                {/* Tab bar — icon-only on mobile, icon+label on sm+.
                    overflow-x-auto is a safety net; with icon-only the 5
                    tabs already fit on a 320px viewport. Scrollbar hidden
                    visually since we don't want it to show in normal use. */}
                <div
                  className="flex bg-white rounded-2xl p-1 shadow-sm mb-5 gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden"
                  style={{ scrollbarWidth: 'none' }}
                >
                  <TabBtn icon="🏷️" label={t('account.vouchersTab')}  active={customerTab === 'vouchers'}  onClick={() => setCustomerTab('vouchers')} />
                  <TabBtn icon="📋" label={t('account.ordersTab')}     active={customerTab === 'orders'}    onClick={() => setCustomerTab('orders')} />
                  {myRestaurants.length > 0 && (
                    <TabBtn icon="🏪" label={t('account.restaurantTab')} active={customerTab === 'restaurant'} onClick={() => setCustomerTab('restaurant')} />
                  )}
                  {myRestaurants.length > 0 && activeRest?.teamRole === 'owner' && (
                    <TabBtn icon="👥" label={t('account.teamTab')} active={customerTab === 'team'} onClick={() => setCustomerTab('team')} />
                  )}
                  <TabBtn icon="👤" label={t('account.profileTab')}   active={customerTab === 'profile'}   onClick={() => setCustomerTab('profile')} />
                </div>

                {/* Vouchers */}
                {customerTab === 'vouchers' && (
                  <>
                    {loadingData && <div className="text-center py-12"><div className="text-3xl animate-pulse text-gray-300">…</div></div>}
                    {!loadingData && (
                      <div className="space-y-3">
                        {customerVouchers.length === 0 ? (
                          <div className="text-center py-12">
                            <div className="text-4xl mb-3">🏷️</div>
                            <p className="text-gray-400 text-sm">{t('account.noVouchers')}</p>
                          </div>
                        ) : customerVouchers.map(cv => cv.vouchers && (
                          <VoucherCard key={cv.id} voucher={cv.vouchers} customerVoucherId={cv.id} usedAt={cv.used_at} />
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Orders */}
                {customerTab === 'orders' && (
                  <>
                    {loadingData && <div className="text-center py-12"><div className="text-3xl animate-pulse text-gray-300">…</div></div>}
                    {!loadingData && (
                      <div className="space-y-3">
                        {orders.length === 0 ? (
                          <div className="text-center py-12">
                            <div className="text-4xl mb-3">📋</div>
                            <p className="text-gray-400 text-sm">{t('account.noOrders')}</p>
                            <Link href="/" className="mt-4 inline-block text-orange-500 text-sm font-semibold underline">
                              Explorer les restaurants
                            </Link>
                          </div>
                        ) : orders.map(order => (
                          <OrderCard key={order.id} order={order} orderAtLabel={t('account.orderAt')} />
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Profile */}
                {customerTab === 'profile' && (
                  <div className="bg-white rounded-2xl shadow-sm p-6 space-y-5">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <h2 className="font-bold text-gray-900">👤 {t('account.profileTab')}</h2>
                      {profile && !profile.deleted_at && (
                        profileEditing ? (
                          <div className="flex gap-2">
                            <button
                              onClick={handleSaveProfile}
                              disabled={savingProfile}
                              className="bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors"
                            >
                              {savingProfile ? '…' : 'Enregistrer / Save'}
                            </button>
                            <button
                              onClick={() => {
                                setProfileEditing(false)
                                setProfileName(profile.name ?? '')
                                setProfileCity(profile.city ?? '')
                              }}
                              className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors"
                            >
                              Annuler / Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setProfileEditing(true)}
                            className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors"
                          >
                            ✏️ Modifier / Edit
                          </button>
                        )
                      )}
                    </div>

                    {/* Fields */}
                    {profile ? (
                      <div className="space-y-4">
                        {/* Status + role badges */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <StatusBadge status={profile.deleted_at ? 'deleted' : profile.status} />
                          <ProfileRoleBadges restaurants={myRestaurants} />
                        </div>

                        {/* Name */}
                        <div>
                          <label className="block text-xs text-gray-400 mb-1">Nom / Name</label>
                          {profileEditing ? (
                            <input
                              value={profileName}
                              onChange={e => setProfileName(e.target.value)}
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400"
                            />
                          ) : (
                            <p className="font-semibold text-gray-900">{profile.name || '—'}</p>
                          )}
                        </div>

                        {/* Phone — read-only */}
                        <div>
                          <label className="block text-xs text-gray-400 mb-1">
                            Téléphone / Phone <span className="text-gray-300">· non modifiable / not editable</span>
                          </label>
                          <p className="font-semibold text-gray-900 font-mono">{profile.phone}</p>
                        </div>

                        {/* City */}
                        <div>
                          <label className="block text-xs text-gray-400 mb-1">Ville / City</label>
                          {profileEditing ? (
                            <select
                              value={profileCity}
                              onChange={e => setProfileCity(e.target.value)}
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400 bg-white"
                            >
                              <option value="">—</option>
                              {PROFILE_CITIES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          ) : (
                            <p className="font-semibold text-gray-900">{profile.city || '—'}</p>
                          )}
                        </div>

                        {/* Member since */}
                        <div>
                          <label className="block text-xs text-gray-400 mb-1">Membre depuis / Member since</label>
                          <p className="text-gray-700 text-sm">
                            {new Date(profile.created_at).toLocaleDateString('fr-FR', {
                              day: 'numeric', month: 'long', year: 'numeric',
                            })}
                          </p>
                        </div>

                        {/* Suspension info */}
                        {profile.status === 'suspended' && profile.suspended_by && (
                          <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-sm text-amber-700">
                            Suspendu par <span className="font-semibold">{profile.suspended_by}</span>
                            {profile.suspended_at && ` · ${new Date(profile.suspended_at).toLocaleDateString('fr-FR')}`}
                            {profile.suspension_reason && (
                              <div className="text-xs mt-1">&quot;{profile.suspension_reason}&quot;</div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-400">Chargement… / Loading…</p>
                    )}

                    {/* Restaurant summary */}
                    {myRestaurants.length > 0 && (
                      <div className="pt-4 border-t border-gray-100">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                          Mes restaurants ({myRestaurants.length}) / My restaurants
                        </p>
                        <div className="space-y-2">
                          {myRestaurants.map(r => (
                            <button
                              key={r.id}
                              onClick={() => { setActiveRestId(r.id); setCustomerTab('restaurant') }}
                              className="w-full bg-gray-50 hover:bg-orange-50 rounded-xl px-3 py-2.5 flex items-center justify-between gap-3 transition-colors text-left"
                            >
                              <div className="min-w-0">
                                <p className="font-semibold text-sm text-gray-900 truncate">{r.name}</p>
                                <p className="text-xs text-gray-500">{r.city}{r.neighborhood ? ` · ${r.neighborhood}` : ''}</p>
                              </div>
                              <StatusBadge status={r.deleted_at ? 'deleted' : r.status} />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Register a new restaurant via WhatsApp */}
                    {!accountDeletedAt && myRestaurants.length === 0 && (
                      <div className="pt-4 border-t border-gray-100">
                        <p className="text-xs text-gray-400 mb-3">Inscrire un restaurant / Register a restaurant</p>
                        <a href="https://wa.me/your-number?text=restaurant" target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 bg-green-500 hover:bg-green-600 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                          🏪 {t('account.registerRest')} via WhatsApp
                        </a>
                      </div>
                    )}

                    {/* Account deletion */}
                    <div className="pt-4 border-t border-gray-100">
                      {accountDeletedAt ? (
                        <div className="space-y-3">
                          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700">
                            ⚠️ Votre compte est en cours de suppression. Les données seront effacées après 30 jours.<br/>
                            Your account is pending deletion. Data will be erased after 30 days.
                          </div>
                          <button
                            onClick={handleUndoDeleteAccount}
                            className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                          >
                            ↩️ Annuler la suppression / Undo deletion
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setVendorModal('delete-account')}
                          className="text-sm text-red-500 hover:text-red-700 font-medium hover:bg-red-50 px-3 py-2 rounded-xl transition-colors"
                        >
                          🗑️ Supprimer mon compte / Delete my account
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Restaurant settings */}
                {customerTab === 'restaurant' && (
                  <div>
                    {/* Multi-restaurant selector */}
                    {myRestaurants.length > 1 && (
                      <div className="mb-4">
                        <label className="block text-xs text-gray-500 mb-1.5">{t('account.selectRest')}</label>
                        <select
                          value={activeRestId}
                          onChange={e => setActiveRestId(e.target.value)}
                          className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-orange-400 bg-white"
                        >
                          {myRestaurants.map(r => (
                            <option key={r.id} value={r.id}>{r.name} — {r.city}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {activeRest && !activeRest.deleted_at && activeRest.status !== 'pending' && (
                      <Link
                        href="/dashboard"
                        className="block bg-orange-500 hover:bg-orange-600 text-white rounded-2xl shadow-sm px-5 py-4 mb-4 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div className="text-3xl">📦</div>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-sm">Tableau de bord / Restaurant Dashboard</p>
                            <p className="text-xs text-white/80 mt-0.5">
                              Gérer commandes, menu et bons / Manage orders, menu and vouchers
                            </p>
                          </div>
                          <span className="text-xl">→</span>
                        </div>
                      </Link>
                    )}

                    {activeRest && (
                      <div className="bg-white rounded-2xl shadow-sm p-6">
                        <div className="flex items-start gap-4 mb-4">
                          {/* Photo */}
                          <div className="relative w-20 h-20 rounded-2xl overflow-hidden flex-shrink-0 bg-orange-50">
                            {activeRest.image_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={activeRest.image_url} alt={activeRest.name} className="w-full h-full object-cover" />
                            ) : (
                              <span className="absolute inset-0 flex items-center justify-center text-3xl">🏪</span>
                            )}
                            {activeRest.teamRole === 'owner' && !activeRest.deleted_at && (
                              <label className="absolute inset-0 bg-black/50 text-white text-[10px] font-semibold flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity cursor-pointer">
                                {uploadingPhoto ? '…' : '📷 Changer'}
                                <input type="file" accept="image/*" className="hidden"
                                  disabled={uploadingPhoto}
                                  onChange={handleRestaurantPhotoUpload} />
                              </label>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2 flex-wrap">
                              <div>
                                <h2 className="font-bold text-gray-900 text-lg">{activeRest.name}</h2>
                                <p className="text-sm text-gray-500">{activeRest.city}{activeRest.neighborhood ? ` · ${activeRest.neighborhood}` : ''}</p>
                                <p className="text-xs text-gray-400 mt-0.5">{activeRest.cuisine_type} · Rôle: {activeRest.teamRole}</p>
                              </div>
                              <StatusBadge status={activeRest.deleted_at ? 'deleted' : activeRest.status} />
                            </div>
                          </div>
                        </div>

                        {/* Banners */}
                        {activeRest.deleted_at && (
                          <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-sm text-red-700">
                            🗑️ {t('account.deletedBanner')}
                          </div>
                        )}
                        {!activeRest.deleted_at && activeRest.status === 'suspended' && (
                          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-sm text-amber-700">
                            ⏸️ {t('account.suspendedBanner')}
                            {activeRest.suspended_by === 'admin' && ' — contactez le support / contact support'}
                          </div>
                        )}

                        {/* Restaurant page link */}
                        <a href={`/restaurant/${activeRest.id}`} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm text-orange-500 hover:text-orange-600 font-semibold mb-5">
                          ↗ Voir la page / View page
                        </a>

                        {/* Actions (owner only) */}
                        {activeRest.teamRole === 'owner' && (
                          <div className="border-t border-gray-100 pt-4 space-y-3">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Paramètres / Settings</p>

                            <div className="flex gap-3 flex-wrap">
                              {activeRest.deleted_at ? (
                                <button
                                  onClick={() => handleRestaurantAction('undo-delete')}
                                  disabled={restActionLoading === 'undo-delete'}
                                  className="bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                                >
                                  {restActionLoading === 'undo-delete' ? '…' : `↩️ ${t('account.undoDelete')}`}
                                </button>
                              ) : (
                                <>
                                  {activeRest.status !== 'suspended' ? (
                                    <button
                                      onClick={() => { setModalReason(''); setVendorModal('suspend-rest') }}
                                      className="bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                                    >
                                      ⏸️ {t('account.suspend')}
                                    </button>
                                  ) : (
                                    activeRest.suspended_by === 'vendor' ? (
                                      <button
                                        onClick={() => handleRestaurantAction('reactivate')}
                                        disabled={restActionLoading === 'reactivate'}
                                        className="bg-green-500 hover:bg-green-600 disabled:bg-green-300 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                                      >
                                        {restActionLoading === 'reactivate' ? '…' : `✅ ${t('account.reactivate')}`}
                                      </button>
                                    ) : (
                                      <p className="text-xs text-amber-600 py-1">Suspendu par l&apos;administration — contactez le support / Suspended by admin — contact support</p>
                                    )
                                  )}
                                  <button
                                    onClick={() => setVendorModal('delete-rest')}
                                    disabled={restActionLoading === 'delete'}
                                    className="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                                  >
                                    {restActionLoading === 'delete' ? '…' : `🗑️ ${t('account.delete')}`}
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Team management */}
                {customerTab === 'team' && activeRest?.teamRole === 'owner' && (
                  <div className="bg-white rounded-2xl shadow-sm p-6">
                    <h2 className="font-bold text-gray-900 mb-4">👥 {t('account.teamTitle')} — {activeRest.name}</h2>

                    {/* Add member form */}
                    <form onSubmit={handleAddTeamMember} className="flex gap-2 mb-5 flex-wrap">
                      <input
                        type="tel"
                        value={teamPhone}
                        onChange={e => setTeamPhone(e.target.value)}
                        placeholder={t('account.memberPhone')}
                        className="flex-1 min-w-0 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                      />
                      <select value={teamRole} onChange={e => setTeamRole(e.target.value)}
                        className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-400 bg-white">
                        <option value="manager">{t('account.roleManager')}</option>
                        <option value="staff">{t('account.roleStaff')}</option>
                      </select>
                      <button type="submit" disabled={addingMember || !teamPhone.trim()}
                        className="bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                        {addingMember ? '…' : t('account.addMember')}
                      </button>
                    </form>
                    {teamError && <p className="text-xs text-red-500 mb-3">{teamError}</p>}

                    {/* Team list */}
                    {loadingTeam ? (
                      <div className="text-center py-8 text-gray-400">Chargement…</div>
                    ) : (
                      <div className="space-y-2">
                        {teamMembers.map(m => (
                          <div key={m.id} className="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0 gap-2 flex-wrap">
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-sm text-gray-900">{m.customers.name}</p>
                              <p className="text-xs text-gray-400 font-mono">{m.customers.phone}</p>
                              {m.added_at && (
                                <p className="text-[11px] text-gray-400 mt-0.5">
                                  Ajouté le {new Date(m.added_at).toLocaleDateString('fr-FR')}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {m.role === 'owner' ? (
                                <span className="text-xs font-medium px-2 py-1 rounded-full bg-indigo-50 text-indigo-700">
                                  Propriétaire / Owner
                                </span>
                              ) : (
                                <select
                                  value={m.role}
                                  onChange={e => handleChangeRole(m.id, e.target.value)}
                                  className="text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-orange-400 bg-white"
                                >
                                  <option value="manager">{t('account.roleManager')}</option>
                                  <option value="staff">{t('account.roleStaff')}</option>
                                </select>
                              )}
                              {m.role !== 'owner' && (
                                <button
                                  onClick={() => handleRemoveTeamMember(m.id)}
                                  className="text-xs text-red-500 hover:text-red-700 font-medium px-2 py-1 hover:bg-red-50 rounded-lg transition-colors"
                                >
                                  {t('account.removeMember')}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                        {teamMembers.length === 0 && <p className="text-gray-400 text-sm text-center py-4">Équipe vide / Empty team</p>}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* ── Vendor modals ── */}

            {/* Suspend restaurant */}
            {vendorModal === 'suspend-rest' && activeRest && (
              <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
                  <h3 className="font-bold text-gray-900 mb-1">⏸️ Suspendre le restaurant / Suspend restaurant</h3>
                  <p className="text-sm text-gray-500 mb-3">{activeRest.name}</p>
                  <textarea
                    value={modalReason}
                    onChange={e => setModalReason(e.target.value)}
                    placeholder="Raison (optionnel) / Reason (optional)"
                    rows={3}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-orange-400 mb-4"
                  />
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleRestaurantAction('suspend')}
                      disabled={restActionLoading === 'suspend'}
                      className="flex-1 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
                    >
                      {restActionLoading === 'suspend' ? '…' : 'Suspendre / Suspend'}
                    </button>
                    <button onClick={() => setVendorModal(null)}
                      className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-200 transition-colors">
                      Annuler / Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Delete restaurant */}
            {vendorModal === 'delete-rest' && activeRest && (
              <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
                  <h3 className="font-bold text-gray-900 mb-1">🗑️ Supprimer le restaurant / Delete restaurant</h3>
                  <p className="text-sm text-gray-500 mb-3">{activeRest.name}</p>
                  <p className="text-sm text-gray-500 mb-4 bg-amber-50 border border-amber-100 rounded-xl p-3">
                    ⚠️ Les données seront supprimées après 30 jours. Vous pouvez annuler dans ce délai.<br/><br/>
                    Data will be deleted after 30 days. You can undo within that period.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleRestaurantAction('delete')}
                      disabled={restActionLoading === 'delete'}
                      className="flex-1 bg-red-500 hover:bg-red-600 disabled:bg-red-300 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
                    >
                      {restActionLoading === 'delete' ? '…' : 'Supprimer / Delete'}
                    </button>
                    <button onClick={() => setVendorModal(null)}
                      className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-200 transition-colors">
                      Annuler / Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Delete account */}
            {vendorModal === 'delete-account' && (
              <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
                  <h3 className="font-bold text-gray-900 mb-1">🗑️ Supprimer mon compte / Delete my account</h3>
                  <p className="text-sm text-gray-500 mb-4 bg-red-50 border border-red-100 rounded-xl p-3">
                    ⚠️ Votre compte et tous vos restaurants seront supprimés après 30 jours. Vous pourrez annuler dans ce délai.<br/><br/>
                    Your account and all your restaurants will be deleted after 30 days. You can undo within that period.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={handleDeleteAccount}
                      className="flex-1 bg-red-500 hover:bg-red-600 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
                    >
                      Confirmer / Confirm
                    </button>
                    <button onClick={() => setVendorModal(null)}
                      className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-200 transition-colors">
                      Annuler / Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

          </div>
        )}

      </div>
    </div>
  )
}

function TabBtn({
  icon, label, active, onClick,
}: {
  icon: string
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex-shrink-0 px-3 py-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap ${
        active ? 'bg-orange-500 text-white' : 'text-gray-600 hover:text-gray-900'
      }`}
    >
      <span aria-hidden="true">{icon}</span>
      {/* Label hides on mobile (<640px) so 5 tabs always fit; icons still
          distinguish them, title/aria-label preserve accessibility. */}
      <span className="hidden sm:inline sm:ml-1">{label}</span>
    </button>
  )
}

function ProfileRoleBadges({ restaurants }: { restaurants: VendorRestaurant[] }) {
  const labels: Record<string, string> = {
    owner:   'Vendeur Propriétaire / Vendor Owner',
    manager: 'Vendeur Manager / Vendor Manager',
    staff:   'Vendeur Staff / Vendor Staff',
  }
  const uniqueRoles = Array.from(new Set(restaurants.map(r => r.teamRole)))
  const badges: React.ReactNode[] = [
    <span key="client" className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
      Client / Customer
    </span>,
  ]
  for (const role of uniqueRoles) {
    badges.push(
      <span key={role} className="text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
        {labels[role] ?? role}
      </span>
    )
  }
  return <>{badges}</>
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active:    'bg-green-100 text-green-700',
    pending:   'bg-amber-100 text-amber-700',
    approved:  'bg-green-100 text-green-700',
    suspended: 'bg-amber-100 text-amber-700',
    deleted:   'bg-red-100 text-red-600',
  }
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0 ${map[status] ?? 'bg-gray-100 text-gray-500'}`}>
      {status}
    </span>
  )
}

const ORDER_STATUS_STYLES: Record<string, { cls: string; label: string }> = {
  pending:   { cls: 'bg-amber-100 text-amber-700',   label: '⏳ En attente / Pending' },
  confirmed: { cls: 'bg-blue-100 text-blue-700',     label: '✅ Confirmée / Confirmed' },
  preparing: { cls: 'bg-indigo-100 text-indigo-700', label: '👨‍🍳 En préparation / Preparing' },
  ready:     { cls: 'bg-green-100 text-green-700',   label: '🎉 Prête / Ready' },
  completed: { cls: 'bg-gray-100 text-gray-700',     label: '🏁 Terminée / Completed' },
  cancelled: { cls: 'bg-red-100 text-red-600',       label: '❌ Annulée / Cancelled' },
}

function OrderStatusBadge({ status }: { status: string }) {
  const s = ORDER_STATUS_STYLES[status] ?? { cls: 'bg-gray-100 text-gray-600', label: status }
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0 ${s.cls}`}>
      {s.label}
    </span>
  )
}

function orderShortId(id: string): string {
  return id.replace(/-/g, '').slice(-4).toUpperCase()
}

function OrderCard({ order, orderAtLabel }: { order: Order; orderAtLabel: string }) {
  const [expanded, setExpanded] = useState(false)
  const items: Array<{ name: string; quantity: number; price?: number }> = Array.isArray(order.items) ? order.items : []
  const itemsSummary = items.map(i => `${i.quantity}× ${i.name}`).join(', ')

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full text-left"
      >
        <div className="flex items-center justify-between mb-1 gap-2">
          <p className="font-semibold text-gray-900 text-sm truncate">
            {orderAtLabel} {order.restaurants?.name ?? '—'}
            <span className="ml-2 text-gray-400 font-mono text-xs">#{orderShortId(order.id)}</span>
          </p>
          <span className="text-xs text-gray-400 flex-shrink-0">{new Date(order.created_at).toLocaleDateString('fr-FR')}</span>
        </div>
        <p className="text-xs text-gray-400 mb-2 truncate">{itemsSummary}</p>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="font-bold text-orange-500 text-sm">{Number(order.total_price).toLocaleString()} FCFA</span>
          <div className="flex items-center gap-2">
            <OrderStatusBadge status={order.status} />
            <span className="text-gray-300 text-sm">{expanded ? '▾' : '▸'}</span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
          {items.length === 0 ? (
            <p className="text-xs text-gray-400">Aucun détail d&apos;article / No item details</p>
          ) : (
            <ul className="space-y-1">
              {items.map((it, idx) => (
                <li key={idx} className="flex items-center justify-between text-sm text-gray-700">
                  <span>{it.quantity}× {it.name}</span>
                  {typeof it.price === 'number' && (
                    <span className="text-gray-500 font-mono">{(it.quantity * it.price).toLocaleString()} FCFA</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between pt-2 border-t border-gray-50">
            <span className="text-xs text-gray-500 uppercase tracking-wide">Total</span>
            <span className="font-bold text-gray-900 font-mono">{Number(order.total_price).toLocaleString()} FCFA</span>
          </div>
        </div>
      )}
    </div>
  )
}
