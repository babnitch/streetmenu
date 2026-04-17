'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import dynamicLoad from 'next/dynamic'
import { supabase } from '@/lib/supabase'
import { useLanguage } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'
import VoucherCard from '@/components/VoucherCard'
import { CustomerVoucher, Order } from '@/types'

// ── Lazy-loaded admin panels (no SSR) ────────────────────────────────────────
const AdminRestaurants = dynamicLoad(() => import('@/app/admin/restaurants/page'), { ssr: false })
const AdminOrders      = dynamicLoad(() => import('@/app/admin/orders/page'),      { ssr: false })
const AdminEvents      = dynamicLoad(() => import('@/app/admin/events/page'),      { ssr: false })
const AdminVouchers    = dynamicLoad(() => import('@/app/admin/vouchers/page'),    { ssr: false })

// ── Types ────────────────────────────────────────────────────────────────────
type AuthStep    = 'loading' | 'login' | 'register' | 'otp' | 'dashboard'
type DashTab     = 'vouchers' | 'orders' | 'admin'
type AdminSubTab = 'restaurants' | 'orders' | 'events' | 'vouchers'

interface CustomerSession {
  id:    string
  phone: string
  name:  string
  city:  string
}

// ── Admin token helpers ──────────────────────────────────────────────────────
function getAdminToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('adminToken') || sessionStorage.getItem('adminToken')
}
function saveAdminToken(token: string, remember: boolean) {
  if (remember) { localStorage.setItem('adminToken', token); sessionStorage.removeItem('adminToken') }
  else          { sessionStorage.setItem('adminToken', token); localStorage.removeItem('adminToken') }
}
function clearAdminToken() {
  localStorage.removeItem('adminToken')
  sessionStorage.removeItem('adminToken')
}

// ── Customer session helpers ─────────────────────────────────────────────────
function getStoredCustomer(): CustomerSession | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem('customerSession') || sessionStorage.getItem('customerSession')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}
function saveCustomerSession(session: CustomerSession, remember: boolean) {
  const raw = JSON.stringify(session)
  if (remember) { localStorage.setItem('customerSession', raw); sessionStorage.removeItem('customerSession') }
  else          { sessionStorage.setItem('customerSession', raw); localStorage.removeItem('customerSession') }
}
function clearCustomerSession() {
  localStorage.removeItem('customerSession')
  sessionStorage.removeItem('customerSession')
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function AccountPage() {
  const { t } = useLanguage()

  // Auth state
  const [step,        setStep]        = useState<AuthStep>('loading')
  const [phone,       setPhone]       = useState('')
  const [password,    setPassword]    = useState('')
  const [rememberMe,  setRememberMe]  = useState(false)
  const [name,        setName]        = useState('')
  const [city,        setCity]        = useState('')
  const [otp,         setOtp]         = useState('')
  const [sending,     setSending]     = useState(false)
  const [verifying,   setVerifying]   = useState(false)
  const [loggingIn,   setLoggingIn]   = useState(false)
  const [error,       setError]       = useState('')

  // Session / dashboard state
  const [isAdmin,          setIsAdmin]          = useState(false)
  const [customer,         setCustomer]         = useState<CustomerSession | null>(null)
  const [tab,              setTab]              = useState<DashTab>('vouchers')
  const [adminSubTab,      setAdminSubTab]      = useState<AdminSubTab>('restaurants')
  const [customerVouchers, setCustomerVouchers] = useState<CustomerVoucher[]>([])
  const [orders,           setOrders]           = useState<Order[]>([])
  const [loadingData,      setLoadingData]      = useState(false)

  // ── Load dashboard data ──
  const loadDashboardData = useCallback(async (customerId: string) => {
    setLoadingData(true)
    const [{ data: cvData }, { data: ordersData }] = await Promise.all([
      supabase
        .from('customer_vouchers')
        .select('*, vouchers(*)')
        .eq('customer_id', customerId)
        .order('claimed_at', { ascending: false }),
      supabase
        .from('orders')
        .select('*, restaurants(name, city)')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(20),
    ])
    if (cvData)    setCustomerVouchers(cvData)
    if (ordersData) setOrders(ordersData)
    setLoadingData(false)
  }, [])

  // ── On mount: restore session ──
  useEffect(() => {
    const adminToken = getAdminToken()
    if (adminToken) {
      fetch('/api/admin/auth', { headers: { 'x-admin-token': adminToken } })
        .then(r => r.json())
        .then(data => {
          if (data.valid) {
            setIsAdmin(true)
            setStep('dashboard')
            setTab('admin')
          } else {
            clearAdminToken()
            restoreCustomerSession()
          }
        })
        .catch(() => { clearAdminToken(); restoreCustomerSession() })
      return
    }
    restoreCustomerSession()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function restoreCustomerSession() {
    const stored = getStoredCustomer()
    if (stored) {
      setCustomer(stored)
      setStep('dashboard')
      loadDashboardData(stored.id)
    } else {
      setStep('login')
    }
  }

  // ── Login form submit (admin password OR customer WhatsApp code) ──
  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password.trim()) {
      // Admin: validate password
      setLoggingIn(true)
      try {
        const res  = await fetch('/api/admin/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password.trim() }),
        })
        const data = await res.json()
        if (!res.ok || !data.token) { setError(t('account.wrongPwd')); return }
        saveAdminToken(data.token, rememberMe)
        setIsAdmin(true)
        setStep('dashboard')
        setTab('admin')
      } finally {
        setLoggingIn(false)
      }
    } else {
      // Customer: send WhatsApp code
      const cleaned = phone.trim()
      if (!cleaned) return
      setSending(true)
      try {
        const res  = await fetch('/api/auth/send-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: cleaned }),
        })
        const data = await res.json()
        if (data.needsRegistration) { setStep('register'); return }
        if (!res.ok) { setError(data.error || 'Erreur / Error'); return }
        setStep('otp')
      } finally {
        setSending(false)
      }
    }
  }

  // ── Register form: new customer enters name + city, then sends code ──
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

  // ── Verify 4-digit WhatsApp code ──
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
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(city        ? { city }               : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Erreur / Error'); return }
      const session: CustomerSession = data.customer
      saveCustomerSession(session, rememberMe)
      setCustomer(session)
      setStep('dashboard')
      setTab('vouchers')
      loadDashboardData(session.id)
    } finally {
      setVerifying(false)
    }
  }

  // ── Sign out ──
  function handleSignOut() {
    clearAdminToken()
    clearCustomerSession()
    setIsAdmin(false)
    setCustomer(null)
    setPhone('')
    setPassword('')
    setName('')
    setCity('')
    setOtp('')
    setCustomerVouchers([])
    setOrders([])
    setStep('login')
  }

  // ── Loading splash ──
  if (step === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#fffaf5' }}>
        <div className="text-4xl animate-bounce">👤</div>
      </div>
    )
  }

  // Admin tab gets wider container
  const containerClass =
    step === 'dashboard' && tab === 'admin'
      ? 'max-w-5xl mx-auto px-4 py-8'
      : 'max-w-md mx-auto px-4 py-8'

  return (
    <div className="min-h-screen" style={{ background: '#fffaf5' }}>
      <TopNav />

      <div className={containerClass}>

        {/* ── Login ── */}
        {step === 'login' && (
          <div className="max-w-md mx-auto bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">👤</div>
              <h1 className="text-xl font-bold text-gray-900">{t('account.title')}</h1>
              <p className="text-sm text-gray-400 mt-1">{t('account.whatsappHint')}</p>
            </div>

            <form onSubmit={handleLoginSubmit} autoComplete="on" className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('account.phoneLbl')}</label>
                <input
                  type="tel" name="phone" autoComplete="tel"
                  value={phone} onChange={e => setPhone(e.target.value)}
                  placeholder={t('account.phonePh')}
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
                <p className="text-xs text-gray-400 mt-1">{t('account.passwordHint')}</p>
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox" checked={rememberMe}
                  onChange={e => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded accent-orange-500"
                />
                <span className="text-sm text-gray-600">{t('account.rememberMe')}</span>
              </label>

              {error && <p className="text-xs text-red-500">{error}</p>}

              <button
                type="submit"
                disabled={loggingIn || sending || !phone.trim()}
                className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors"
              >
                {(loggingIn || sending)
                  ? (password.trim() ? t('account.loggingIn') : t('account.sending'))
                  : (password.trim() ? t('account.loginBtn')  : t('account.sendOtp'))}
              </button>
            </form>
          </div>
        )}

        {/* ── Register (new customer: enter name + city) ── */}
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
                <input
                  type="text" value={name} onChange={e => setName(e.target.value)}
                  placeholder={t('account.namePh')}
                  className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Ville / City</label>
                <select
                  value={city} onChange={e => setCity(e.target.value)}
                  className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400 bg-white"
                >
                  <option value="">Choisir / Select…</option>
                  <option value="Yaoundé">Yaoundé</option>
                  <option value="Abidjan">Abidjan</option>
                  <option value="Dakar">Dakar</option>
                  <option value="Lomé">Lomé</option>
                </select>
              </div>

              {error && <p className="text-xs text-red-500">{error}</p>}

              <button
                type="submit"
                disabled={sending || !name.trim() || !city}
                className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors"
              >
                {sending ? t('account.sending') : t('account.sendOtp')}
              </button>

              <button
                type="button"
                onClick={() => { setStep('login'); setError('') }}
                className="w-full text-gray-400 text-sm py-2 hover:text-gray-600 transition-colors"
              >
                {t('account.changePhone')}
              </button>
            </form>
          </div>
        )}

        {/* ── OTP (4-digit WhatsApp code) ── */}
        {step === 'otp' && (
          <div className="max-w-md mx-auto bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">💬</div>
              <h1 className="text-xl font-bold text-gray-900">{t('account.otpLbl')}</h1>
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

            <button
              onClick={verifyOtp}
              disabled={verifying || otp.length < 4}
              className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors mb-3"
            >
              {verifying ? t('account.verifying') : t('account.verify')}
            </button>

            <button
              onClick={() => { setStep('login'); setOtp(''); setError('') }}
              className="w-full text-gray-400 text-sm py-2 hover:text-gray-600 transition-colors"
            >
              {t('account.changePhone')}
            </button>
          </div>
        )}

        {/* ── Dashboard ── */}
        {step === 'dashboard' && (
          <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <p className="text-xs text-gray-400">{t('account.hello')}</p>
                <p className="font-bold text-gray-900 text-lg">
                  {isAdmin ? '🔐 Admin' : (customer?.name ?? '')}
                </p>
              </div>
              <button
                onClick={handleSignOut}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors px-3 py-1.5 rounded-xl hover:bg-red-50"
              >
                {t('account.signOut')}
              </button>
            </div>

            {/* Tab bar */}
            <div className="flex bg-white rounded-2xl p-1 shadow-sm mb-5 gap-1">
              <button
                onClick={() => setTab('vouchers')}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${tab === 'vouchers' ? 'bg-orange-500 text-white' : 'text-gray-600 hover:text-gray-900'}`}
              >
                🏷️ {t('account.vouchersTab')}
              </button>
              <button
                onClick={() => setTab('orders')}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${tab === 'orders' ? 'bg-orange-500 text-white' : 'text-gray-600 hover:text-gray-900'}`}
              >
                📋 {t('account.ordersTab')}
              </button>
              {isAdmin && (
                <button
                  onClick={() => setTab('admin')}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${tab === 'admin' ? 'bg-gray-800 text-white' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  🔐 {t('account.adminTab')}
                </button>
              )}
            </div>

            {/* Vouchers */}
            {tab === 'vouchers' && (
              <>
                {loadingData && <div className="text-center py-12"><div className="text-3xl animate-pulse text-gray-300">…</div></div>}
                {!loadingData && (
                  <div className="space-y-3">
                    {customerVouchers.length === 0 ? (
                      <div className="text-center py-12">
                        <div className="text-4xl mb-3">🏷️</div>
                        <p className="text-gray-400 text-sm">{t('account.noVouchers')}</p>
                      </div>
                    ) : (
                      customerVouchers.map(cv =>
                        cv.vouchers && (
                          <VoucherCard
                            key={cv.id}
                            voucher={cv.vouchers}
                            customerVoucherId={cv.id}
                            usedAt={cv.used_at}
                          />
                        )
                      )
                    )}
                  </div>
                )}
              </>
            )}

            {/* Orders */}
            {tab === 'orders' && (
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
                    ) : (
                      orders.map(order => (
                        <div key={order.id} className="bg-white rounded-2xl shadow-sm p-4">
                          <div className="flex items-center justify-between mb-1">
                            <p className="font-semibold text-gray-900 text-sm">
                              {t('account.orderAt')} {order.restaurants?.name ?? '—'}
                            </p>
                            <span className="text-xs text-gray-400">
                              {new Date(order.created_at).toLocaleDateString('fr-FR')}
                            </span>
                          </div>
                          <p className="text-xs text-gray-400 mb-2">
                            {Array.isArray(order.items)
                              ? order.items.map((it: { name: string; quantity: number }) => `${it.quantity}× ${it.name}`).join(', ')
                              : ''}
                          </p>
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-orange-500 text-sm">
                              {Number(order.total_price).toLocaleString()} FCFA
                            </span>
                            <span className="text-xs bg-orange-50 text-orange-600 px-2 py-0.5 rounded-full font-medium capitalize">
                              {order.status}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </>
            )}

            {/* Admin */}
            {tab === 'admin' && isAdmin && (
              <div>
                <div className="flex gap-2 mb-5 overflow-x-auto pb-1">
                  {(['restaurants', 'orders', 'events', 'vouchers'] as AdminSubTab[]).map(sub => (
                    <button
                      key={sub}
                      onClick={() => setAdminSubTab(sub)}
                      className={`px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap transition-colors ${
                        adminSubTab === sub
                          ? 'bg-gray-800 text-white'
                          : 'bg-white text-gray-600 shadow-sm hover:text-gray-900'
                      }`}
                    >
                      {t(`account.adminNav${sub.charAt(0).toUpperCase()}${sub.slice(1)}` as Parameters<typeof t>[0])}
                    </button>
                  ))}
                </div>
                {adminSubTab === 'restaurants' && <AdminRestaurants />}
                {adminSubTab === 'orders'      && <AdminOrders />}
                {adminSubTab === 'events'      && <AdminEvents />}
                {adminSubTab === 'vouchers'    && <AdminVouchers />}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
